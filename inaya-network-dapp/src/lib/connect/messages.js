// src/lib/connect/messages.js -- SOW B, I, J: the message ledger, outbound sending with usage limits and the 24-hour
// customer-service window, delivery statuses (out-of-order safe), opt-out/suppression and per-company usage counters.
// Content is stored for the conversation history only (retention: see retention.js); events/audit never carry it.
import { ccol, oid, sid, clean, fail, nowIso, K, getSettings, digits, event } from "./core.js";
import { sendText } from "./graph.js";

const STATUS_RANK = { queued: 0, sent: 1, delivered: 2, read: 3, failed: 9 };
const month = (d = new Date()) => d.toISOString().slice(0, 7);
export const WINDOW_MS = 24 * 3600000;

export async function bumpUsage(orgId, field, n = 1) {
  const c = await ccol(); const m = month();
  await c.updateOne({ orgId: oid(orgId), kind: K.usage, month: m }, { $inc: { [field]: n }, $setOnInsert: { orgId: oid(orgId), kind: K.usage, opsDoc: true, opsKey: `usage:${m}`, month: m } }, { upsert: true });
}
export async function usageThisMonth(orgId) { const c = await ccol(); return (await c.findOne({ orgId: oid(orgId), kind: K.usage, month: month() })) || {}; }

export async function isSuppressed(orgId, number) { const c = await ccol(); return !!(await c.findOne({ orgId: oid(orgId), kind: K.contact, number: digits(number), optedOut: true }, { projection: { _id: 1 } })); }
export async function setOptOut(orgId, number, optedOut) {
  const c = await ccol(); const n = digits(number); const now = nowIso();
  await c.updateOne({ orgId: oid(orgId), kind: K.contact, number: n }, { $set: { optedOut: !!optedOut, optChangedAt: now }, $setOnInsert: { orgId: oid(orgId), kind: K.contact, opsDoc: true, opsKey: `contact:${n}`, number: n, createdAt: now } }, { upsert: true });
}
/** Last inbound from this number (opens the 24-hour service window). */
export async function lastInboundAt(orgId, number) { const c = await ccol(); const m = await c.find({ orgId: oid(orgId), kind: K.msg, direction: "in", from: digits(number) }).sort({ at: -1 }).limit(1).toArray(); return m[0]?.at || null; }

/**
 * Sends one free-form text. Refuses (never silently drops) when: suppressed (opt-out), outside the 24-hour window
 * (a template is needed), or over the company's monthly limit. Records the outbound message and usage.
 */
export async function sendMessage({ orgId, conn, to, text, actorEmail = "inaya-connect", category = "service", kind = "reply", convId = null, aiGenerated = false }) {
  const n = digits(to); const s = await getSettings(orgId);
  if (await isSuppressed(orgId, n) && kind !== "optout_confirm") return fail("This person opted out of WhatsApp messages.", 409, "OPTED_OUT");
  if (kind !== "test") { const last = await lastInboundAt(orgId, n); if (!last || Date.now() - new Date(last).getTime() > WINDOW_MS) return fail("More than 24 hours since this person last wrote. WhatsApp requires an approved template message to start a new conversation.", 409, "OUTSIDE_WINDOW"); }
  const u = await usageThisMonth(orgId); if ((u.outbound || 0) >= s.limits.monthlyOutbound) { await event({ orgId, type: "usage_limit", outcome: "blocked", connId: conn._id }); return fail("This month's WhatsApp message limit for your company is reached. An admin can raise it in Inaya Connect settings.", 429, "LIMIT"); }
  const c = await ccol(); const now = nowIso();
  const doc = { orgId: oid(orgId), kind: K.msg, opsDoc: true, direction: "out", connId: conn._id, convId: oid(convId), to: n, type: "text", text: clean(text, 4096), status: "queued", category, sendKind: kind, aiGenerated: !!aiGenerated, by: actorEmail, at: now };
  const ins = await c.insertOne(doc);
  try {
    const r = await sendText(conn, n, doc.text);
    await c.updateOne({ _id: ins.insertedId }, { $set: { waMessageId: r.waMessageId, status: "sent", sentAt: nowIso(), ...(r.waMessageId ? { opsKey: `wamsg:${r.waMessageId}` } : {}) } });
    await c.updateOne({ _id: conn._id }, { $set: { lastOutboundAt: nowIso(), lastError: null } });
    await bumpUsage(orgId, "outbound"); await bumpUsage(orgId, `out_${category}`);
    return { ok: true, waMessageId: r.waMessageId, messageId: sid(ins.insertedId) };
  } catch (e) {
    const msg = String(e.message).slice(0, 300);
    await c.updateOne({ _id: ins.insertedId }, { $set: { status: "failed", error: msg } });
    await c.updateOne({ _id: conn._id }, { $set: { lastError: { at: nowIso(), message: msg, code: e.code || null } } });
    await event({ orgId, type: "send", outcome: "failed", connId: conn._id, detail: { code: e.code || null, status: e.status || null } });
    if (e.code === 190) return fail("Meta rejected the access token (expired or revoked). An admin must update it in Inaya Connect.", 502, "TOKEN");
    return fail(`WhatsApp didn't accept the message: ${msg}`, 502, "SEND_FAILED");
  }
}

/** Delivery status from the webhook. Never moves backwards (out-of-order safe); a failure always records the reason. */
export async function applyStatus({ orgId, status }) {
  const c = await ccol(); const id = status?.id; const st = String(status?.status || "");
  if (!id || !(st in STATUS_RANK)) return { ignored: true };
  const m = await c.findOne({ orgId: oid(orgId), kind: K.msg, waMessageId: id }); if (!m) return { unknown: true };
  if (st !== "failed" && STATUS_RANK[st] <= (STATUS_RANK[m.status] ?? 0)) return { stale: true };
  const set = { status: st, [`statusAt.${st}`]: nowIso() };
  if (st === "failed") set.error = clean(status.errors?.[0]?.title || status.errors?.[0]?.message || "failed", 300);
  if (status.pricing?.category) set.billedCategory = clean(status.pricing.category, 30);
  if (status.pricing?.billable !== undefined) set.billable = !!status.pricing.billable;
  await c.updateOne({ _id: m._id }, { $set: set });
  if (st === "failed") await event({ orgId, type: "delivery", outcome: "failed", connId: m.connId, waMessageId: id, detail: { error: set.error } });
  if (status.pricing?.billable) await bumpUsage(orgId, "billable");
  return { ok: true };
}
