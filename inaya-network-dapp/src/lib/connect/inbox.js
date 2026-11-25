// src/lib/connect/inbox.js -- SOW F, G, J: the shared WhatsApp inbox, the document review queue, usage and monitoring.
//   Inbox: conversations (AI or HUMAN mode), messages, reply as a person (24-hour rule enforced by messages.js), take over
//   (AI pauses), resume AI, assign, internal notes (never sent), close/reopen, open a support desk ticket from a chat.
//   Documents: list, open the stored file, route to AI Bookkeeper / mark filed / reject. Nothing is filed automatically.
//   Usage: this month's counts and an ESTIMATE (Meta's invoice is authoritative). Events: delivery failures, rejected
//   webhooks, quarantines, hand-overs -- without message content.
import { ccol, oid, sid, clean, fail, nowIso, K, getSettings, audit, maskPhone, connectAccess } from "./core.js";
import { getConnection } from "./connection.js";
import { sendMessage, usageThisMonth } from "./messages.js";
import { getObject } from "./intake.js";

const convView = (c) => ({ id: sid(c._id), number: maskPhone(c.number), rawNumber: c.number, name: c.profileName || null, audience: c.audience || "customer", mode: c.mode, status: c.status, assignee: c.assignee || null, unread: c.unread || 0, lastMessageAt: c.lastMessageAt, lastInboundAt: c.lastInboundAt, handoverReason: c.handoverReason || null, verified: !!(c.verifiedUntil && c.verifiedUntil > nowIso()), ticketId: c.ticketId || null });
const msgView = (m) => ({ id: sid(m._id), direction: m.direction, type: m.type, text: m.text || null, media: m.media ? { mime: m.media.mime, filename: m.media.filename } : null, status: m.status || null, error: m.error || null, by: m.by || null, ai: !!m.aiGenerated, note: m.direction === "note", at: m.at });

async function convOf(orgId, convId) { const c = await ccol(); const v = await c.findOne({ _id: oid(convId), orgId: oid(orgId), kind: K.conv }); return v || null; }

export async function listConversations({ orgId, membership, status = "OPEN", mode, mine, q }) {
  const d = await connectAccess({ orgId, membership, need: "agent" }); if (d) return d;
  const c = await ccol(); const f = { orgId: oid(orgId), kind: K.conv };
  if (status && status !== "ALL") f.status = status; if (mode) f.mode = mode; if (mine) f.assignee = membership.email;
  if (q) { const n = String(q).replace(/[^\d]/g, ""); f.$or = [{ profileName: new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 40), "i") }, ...(n.length >= 4 ? [{ number: new RegExp(`${n}$`) }] : [])]; }
  const rows = await c.find(f).sort({ lastMessageAt: -1 }).limit(100).toArray();
  return { conversations: rows.map(convView) };
}
export async function getConversation({ orgId, membership, convId }) {
  const d = await connectAccess({ orgId, membership, need: "agent" }); if (d) return d;
  const conv = await convOf(orgId, convId); if (!conv) return fail("Conversation not found.", 404);
  const c = await ccol(); const msgs = await c.find({ orgId: oid(orgId), kind: K.msg, convId: conv._id }).sort({ at: -1 }).limit(200).toArray();
  await c.updateOne({ _id: conv._id }, { $set: { unread: 0 } });
  const windowOpen = !!(conv.lastInboundAt && Date.now() - new Date(conv.lastInboundAt).getTime() < 24 * 3600000);
  return { conversation: convView(conv), messages: msgs.reverse().map(msgView), windowOpen };
}
export async function reply({ orgId, membership, actorEmail, convId, text }) {
  const d = await connectAccess({ orgId, membership, need: "agent" }); if (d) return d;
  const conv = await convOf(orgId, convId); if (!conv) return fail("Conversation not found.", 404);
  const t = clean(text, 4096); if (!t) return fail("Write a message.");
  const conn = await getConnection(orgId); if (!conn || conn.status !== "ACTIVE") return fail("The WhatsApp number isn't connected.", 409);
  const c = await ccol();
  if (conv.mode !== "HUMAN") await c.updateOne({ _id: conv._id }, { $set: { mode: "HUMAN", takenOverBy: actorEmail, takenOverAt: nowIso() } }); // a person replying pauses the AI
  const r = await sendMessage({ orgId, conn, to: conv.number, text: t, actorEmail, kind: "agent", convId: conv._id });
  if (r.error) return r;
  await c.updateOne({ _id: conv._id }, { $set: { lastMessageAt: nowIso(), ...(conv.assignee ? {} : { assignee: actorEmail }) } });
  return r;
}
export async function setMode({ orgId, membership, actorEmail, convId, action, assignee, note }) {
  const d = await connectAccess({ orgId, membership, need: "agent" }); if (d) return d;
  const conv = await convOf(orgId, convId); if (!conv) return fail("Conversation not found.", 404);
  const c = await ccol(); const now = nowIso();
  if (action === "takeover") await c.updateOne({ _id: conv._id }, { $set: { mode: "HUMAN", takenOverBy: actorEmail, takenOverAt: now, assignee: conv.assignee || actorEmail } });
  else if (action === "resume_ai") await c.updateOne({ _id: conv._id }, { $set: { mode: "AI" }, $unset: { handoverReason: "" } });
  else if (action === "assign") { const { getMembership } = await import("../orgs.js"); const to = clean(assignee, 200).toLowerCase(); if (to) { const m = await getMembership(sid(orgId), to); if (!m || m.status === "removed") return fail("That person isn't a member of this company."); } await c.updateOne({ _id: conv._id }, { $set: { assignee: to || null } }); }
  else if (action === "close") await c.updateOne({ _id: conv._id }, { $set: { status: "CLOSED", closedAt: now, closedBy: actorEmail, mode: "AI" } });
  else if (action === "reopen") await c.updateOne({ _id: conv._id }, { $set: { status: "OPEN" } });
  else if (action === "note") { const t = clean(note, 2000); if (!t) return fail("Write a note."); await c.insertOne({ orgId: oid(orgId), kind: K.msg, opsDoc: true, direction: "note", convId: conv._id, type: "note", text: t, by: actorEmail, at: now }); }
  else if (action === "ticket") return toTicket({ orgId, membership, actorEmail, conv });
  else return fail("Unknown action.");
  await audit({ orgId, actorEmail, action: `CONNECT_CONVERSATION_${String(action).toUpperCase()}`, recordId: conv._id, metadata: { number: maskPhone(conv.number), ...(action === "assign" ? { assignee: clean(assignee, 200) || null } : {}) } });
  return { ok: true };
}
/** Opens a support desk ticket with the recent transcript (the existing desk stays the system of record for cases). */
async function toTicket({ orgId, membership, actorEmail, conv }) {
  if (conv.ticketId) return { ok: true, ticketId: conv.ticketId, existing: true };
  const c = await ccol(); const msgs = (await c.find({ orgId: oid(orgId), kind: K.msg, convId: conv._id, direction: { $in: ["in", "out"] } }).sort({ at: -1 }).limit(20).toArray()).reverse();
  const transcript = msgs.map((m) => `${m.direction === "in" ? "Customer" : m.by === "inaya-connect" ? "Assistant" : m.by}: ${m.text || `[${m.type}]`}`).join("\n");
  const { createTicket } = await import("../support/tickets.js"); const { getSettings: supportSettings } = await import("../support/settings.js");
  let email = null; if (conv.verifiedContactId) { const { getOrgCollections } = await import("../orgs.js"); const { crmContacts } = await getOrgCollections(); email = (await crmContacts.findOne({ _id: conv.verifiedContactId, orgId: oid(orgId) }, { projection: { email: 1 } }))?.email || null; }
  const r = await createTicket({ orgId: sid(orgId), settings: await supportSettings(sid(orgId)), actor: { type: "agent", email: actorEmail, staff: true }, requester: { email: email || `wa-${conv.number}@whatsapp.invalid`, name: conv.profileName || maskPhone(conv.number) }, subject: `WhatsApp: ${conv.profileName || maskPhone(conv.number)}`, description: `Conversation from WhatsApp (${maskPhone(conv.number)}${email ? ", verified customer" : ", not verified"}). Reply to the customer in Inaya Connect › Inbox.\n\n${transcript}`.slice(0, 8000), channel: "WHATSAPP", unverified: !email, assigneeEmail: conv.assignee || actorEmail, idempotencyKey: `wa:${sid(conv._id)}` });
  if (r?.error) return r; void membership;
  const ticketId = sid(r.ticket?._id); await c.updateOne({ _id: conv._id }, { $set: { ticketId, ticketNumber: r.ticket?.number || null } });
  await audit({ orgId, actorEmail, action: "CONNECT_TICKET_CREATED", recordId: conv._id, metadata: { ticketId } });
  return { ok: true, ticketId, ticketNumber: r.ticket?.number || null };
}

// ------------------------------------------------------------------ documents
const docView = (x) => ({ id: sid(x._id), ref: x.ref || null, status: x.status, reason: x.reason || null, filename: x.filename || null, mime: x.mime || null, size: x.size || null, from: maskPhone(x.from), senderType: x.senderType, senderEmail: x.senderEmail || null, caption: x.caption || null, suggested: x.suggested || null, destination: x.destination || null, decidedBy: x.decidedBy || null, at: x.at });
export async function listDocuments({ orgId, membership, status = "REVIEW" }) {
  const d = await connectAccess({ orgId, membership, need: "agent" }); if (d) return d;
  const c = await ccol(); const rows = await c.find({ orgId: oid(orgId), kind: K.doc, ...(status && status !== "ALL" ? { status } : {}) }).sort({ at: -1 }).limit(100).toArray();
  return { documents: rows.map(docView) };
}
export async function documentFile({ orgId, membership, docId }) {
  const d = await connectAccess({ orgId, membership, need: "agent" }); if (d) return d;
  const c = await ccol(); const x = await c.findOne({ _id: oid(docId), orgId: oid(orgId), kind: K.doc }); if (!x?.storage?.key) return fail("No stored file for this document.", 404);
  const body = await getObject({ orgId, key: x.storage.key, versionId: x.storage.versionId || undefined });
  const buffer = Buffer.isBuffer(body) ? body : Buffer.isBuffer(body?.buffer) ? body.buffer : body?.body ? Buffer.from(body.body) : null;
  if (!buffer) return fail("The file couldn't be read.", 502);
  return { buffer, filename: x.filename, mime: x.mime };
}
/** action: bookkeeper (send to AI Bookkeeper intake) | filed (a person filed it elsewhere, with a note) | reject */
export async function decideDocument({ orgId, membership, actorEmail, docId, action, note }) {
  const d = await connectAccess({ orgId, membership, need: "agent" }); if (d) return d;
  const c = await ccol(); const x = await c.findOne({ _id: oid(docId), orgId: oid(orgId), kind: K.doc }); if (!x) return fail("Document not found.", 404);
  if (!["REVIEW"].includes(x.status)) return fail("This document was already handled.", 409);
  const set = { decidedBy: actorEmail, decidedAt: nowIso(), note: clean(note, 500) || null };
  if (action === "bookkeeper") {
    const f = await documentFile({ orgId, membership, docId }); if (f.error) return f;
    const { getSource, createSource } = await import("../bookkeeper/sources.js"); const s = await getSettings(orgId);
    let src = s.bookkeeperSourceId ? await getSource({ orgId, sourceId: s.bookkeeperSourceId }) : null;
    if (!src || src.status !== "ACTIVE") { const { getOrgCollections } = await import("../orgs.js"); const { departments } = await getOrgCollections(); const dep = await departments.findOne({ orgId: oid(orgId) }, { sort: { createdAt: 1 } }); if (!dep) return fail("Create a department first (AI Bookkeeper needs one)."); const r = await createSource({ orgId, type: "API", name: "Inaya Connect (WhatsApp)", departmentId: sid(dep._id), actor: actorEmail }); if (r.error) return r; src = await getSource({ orgId, sourceId: r.source.id }); await c.updateOne({ orgId: oid(orgId), kind: K.settings }, { $set: { "settings.bookkeeperSourceId": r.source.id }, $setOnInsert: { orgId: oid(orgId), kind: K.settings, opsDoc: true } }, { upsert: true }); }
    const { ingestDocument } = await import("../bookkeeper/documents.js");
    const r = await ingestDocument({ orgId: sid(orgId), source: src, channel: "WHATSAPP", filename: f.filename, contentType: f.mime, buffer: f.buffer, externalId: x.waMessageId, meta: { via: "inaya-connect", ref: x.ref }, actor: actorEmail });
    if (r.error) return r;
    Object.assign(set, { status: "ROUTED", destination: "bookkeeper", bookkeeperDocumentId: sid(r.document?.id || r.documentId || r.id) });
  } else if (action === "filed") { if (!set.note) return fail("Say where it was filed."); Object.assign(set, { status: "FILED", destination: "manual" }); }
  else if (action === "reject") Object.assign(set, { status: "REJECTED" });
  else return fail("Unknown action.");
  await c.updateOne({ _id: x._id }, { $set: set });
  await audit({ orgId, actorEmail, action: `CONNECT_DOCUMENT_${set.status}`, recordId: x._id, metadata: { ref: x.ref, note: set.note } });
  return { ok: true, status: set.status };
}

// ------------------------------------------------------------------ usage + monitoring
export async function usage({ orgId, membership }) {
  const d = await connectAccess({ orgId, membership, need: "agent" }); if (d) return d;
  const u = await usageThisMonth(orgId); const s = await getSettings(orgId);
  const billable = u.billable || 0; const est = Math.round(billable * (s.pricing?.perMessageEstimate || 0) * 100) / 100;
  return { month: u.month || new Date().toISOString().slice(0, 7), inbound: u.inbound || 0, outbound: u.outbound || 0, billable, limit: s.limits.monthlyOutbound, estimate: { amount: est, currency: s.pricing?.currency || "USD", note: "Estimate only. Meta bills your WhatsApp Business Account directly; its invoice is the authoritative amount." } };
}
export async function events({ orgId, membership, type }) {
  const d = await connectAccess({ orgId, membership, need: "admin" }); if (d) return d;
  const c = await ccol(); const rows = await c.find({ orgId: oid(orgId), kind: K.event, ...(type ? { type: clean(type, 40) } : {}) }).sort({ at: -1 }).limit(100).toArray();
  return { events: rows.map((e) => ({ id: sid(e._id), type: e.type, outcome: e.outcome, contact: e.contact, detail: e.detail || {}, at: e.at })) };
}
