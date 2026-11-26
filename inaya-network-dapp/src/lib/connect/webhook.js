// src/lib/connect/webhook.js -- SOW B2, 8.1, 8.2: the one platform webhook (/api/connect/whatsapp).
//   GET  verification: hub.verify_token is "icv_<random>"; it is matched against the stored HASH of each pending
//        connection's token (one active connection per number), and marks the connection ACTIVE.
//   POST events: the tenant is resolved ONLY from metadata.phone_number_id via the global waKey index, then the
//        X-Hub-Signature-256 HMAC is checked with THAT connection's app secret (or the platform app secret once Inaya
//        is a Tech Provider). Unknown, disconnected or mismatched numbers are rejected and recorded, never routed.
//   Messages are written once (unique per WhatsApp message id) and queued for processing; statuses update the ledger.
import { createHmac } from "node:crypto";
import { ccol, oid, sid, nowIso, K, secretOf, safeEqual, sha256, digits, event } from "./core.js";
import { applyStatus, bumpUsage } from "./messages.js";

const MAX_BODY = 1024 * 1024;
const hmac = (secret, raw) => createHmac("sha256", secret).update(raw).digest("hex");

export async function verifyChallenge(query) {
  const mode = query["hub.mode"]; const tok = String(query["hub.verify_token"] || ""); const challenge = String(query["hub.challenge"] || "");
  if (mode !== "subscribe" || !/^icv_[A-Za-z0-9_-]{20,40}$/.test(tok) || !challenge) return { status: 403, text: "Forbidden" };
  const c = await ccol();
  const conn = await c.findOne({ kind: K.conn, verifyTokenHash: sha256(tok), status: { $in: ["PENDING_WEBHOOK", "ACTIVE"] } });
  if (!conn) { await event({ type: "webhook_verify", outcome: "rejected" }); return { status: 403, text: "Forbidden" }; }
  await c.updateOne({ _id: conn._id }, { $set: { status: "ACTIVE", webhookVerifiedAt: nowIso() } });
  await event({ orgId: conn.orgId, type: "webhook_verify", outcome: "ok", connId: conn._id });
  return { status: 200, text: challenge.slice(0, 200) };
}

function phoneIdsOf(body) {
  const ids = new Set();
  for (const e of Array.isArray(body?.entry) ? body.entry.slice(0, 50) : []) for (const ch of Array.isArray(e?.changes) ? e.changes.slice(0, 50) : []) if (ch?.value?.metadata?.phone_number_id) ids.add(String(ch.value.metadata.phone_number_id));
  return [...ids];
}

/** Returns { status, body, orgIds } (orgIds: companies that have new messages to process). */
export async function receiveEvents({ headers, rawBody }) {
  if (Buffer.byteLength(rawBody || "") > MAX_BODY) return { status: 413, body: { error: "Too large." } };
  let body; try { body = JSON.parse(rawBody); } catch { return { status: 400, body: { error: "Invalid JSON." } }; }
  if (body?.object !== "whatsapp_business_account") return { status: 200, body: { ignored: true } };
  const sig = String(headers["x-hub-signature-256"] || "").replace(/^sha256=/, "");
  const c = await ccol(); const out = { messages: 0, duplicates: 0, statuses: 0, rejected: 0 }; const orgIds = new Set();
  const platformSecret = process.env.WHATSAPP_APP_SECRET || null;
  const platformOk = platformSecret && sig && safeEqual(sig, hmac(platformSecret, rawBody));
  const conns = new Map();
  for (const pnid of phoneIdsOf(body)) {
    const conn = await c.findOne({ waKey: `pnid:${pnid}` });
    if (!conn || !["ACTIVE", "PENDING_WEBHOOK"].includes(conn.status)) { out.rejected++; await event({ orgId: conn?.orgId || null, type: "webhook_event", outcome: conn ? "rejected_inactive" : "rejected_unknown_number", detail: { phoneNumberId: pnid } }); continue; }
    const secret = secretOf(conn.appSecretEncrypted);
    if (!platformOk && !(secret && sig && safeEqual(sig, hmac(secret, rawBody)))) { out.rejected++; await event({ orgId: conn.orgId, type: "webhook_event", outcome: "rejected_signature", connId: conn._id }); continue; }
    // A correctly signed event proves Meta is delivering to us for this app: a reconnected number goes live without
    // repeating the verify handshake in Meta.
    if (conn.status === "PENDING_WEBHOOK") { await c.updateOne({ _id: conn._id }, { $set: { status: "ACTIVE", webhookVerifiedAt: nowIso(), activatedBy: "signed_event" } }); conn.status = "ACTIVE"; await event({ orgId: conn.orgId, type: "webhook_verify", outcome: "ok_signed_event", connId: conn._id }); }
    conns.set(pnid, conn);
  }
  if (!conns.size) return { status: out.rejected ? 401 : 200, body: out };
  for (const e of body.entry.slice(0, 50)) for (const ch of (e.changes || []).slice(0, 50)) {
    const v = ch?.value; const conn = conns.get(String(v?.metadata?.phone_number_id || "")); if (!conn) continue;
    const names = new Map((v.contacts || []).map((x) => [digits(x.wa_id), String(x.profile?.name || "").slice(0, 80)]));
    for (const m of (v.messages || []).slice(0, 50)) {
      if (!m?.id || !m.from) continue;
      const from = digits(m.from); const now = nowIso();
      const doc = { orgId: conn.orgId, kind: K.msg, opsDoc: true, opsKey: `wamsg:${m.id}`, waMessageId: m.id, direction: "in", connId: conn._id, from, profileName: names.get(from) || null, type: String(m.type || "unknown"),
        text: m.type === "text" ? String(m.text?.body || "").slice(0, 4096) : m.type === "button" ? String(m.button?.text || "").slice(0, 200) : m.type === "interactive" ? String(m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || "").slice(0, 200) : (m[m.type]?.caption ? String(m[m.type].caption).slice(0, 1000) : null),
        media: ["image", "document", "audio", "video", "sticker"].includes(m.type) ? { id: m[m.type]?.id || null, mime: m[m.type]?.mime_type || null, filename: m[m.type]?.filename ? String(m[m.type].filename).slice(0, 160) : null, sha256: m[m.type]?.sha256 || null } : null,
        context: m.context?.id ? { replyTo: m.context.id, forwarded: !!m.context.forwarded } : null,
        waTimestamp: m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : null, at: now, processing: "PENDING", attempts: 0 };
      try { await c.insertOne(doc); out.messages++; orgIds.add(sid(conn.orgId)); await bumpUsage(conn.orgId, "inbound"); }
      catch (err) { if (err?.code === 11000) { out.duplicates++; continue; } throw err; }
    }
    for (const s of (v.statuses || []).slice(0, 100)) { await applyStatus({ orgId: conn.orgId, status: s }); out.statuses++; }
    await c.updateOne({ _id: conn._id }, { $set: { lastInboundAt: nowIso() } });
  }
  if (out.duplicates) await event({ type: "webhook_event", outcome: "duplicates_suppressed", detail: { count: out.duplicates } });
  return { status: 200, body: out, orgIds: [...orgIds] };
}
void oid;
