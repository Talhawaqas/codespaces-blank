// src/lib/chat/contacts.js
//
// Secure contacts (SOW A2, CONTACT-001..004). Inside an organization everyone is reachable through the membership
// directory. Reaching someone OUTSIDE it is opt-in on both sides and purpose-bound: the organization must allow it
// (chatSettings.allowExternal), the other person must accept a request that carries a stated purpose, and the response to a
// request never reveals whether an address belongs to anyone (no cross-tenant directory enumeration).

import { ObjectId } from "mongodb";
import { slidingWindowCheck } from "../rateLimit.js";
import { logOrgActivity } from "../org-activity-log.js";
import { createNotification } from "../notifications.js";
import { LIMITS, chatDb, fail, getOrgCollections, nowIso, normEmail } from "./common.js";

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const pair = (x, y) => [normEmail(x), normEmail(y)].sort();
const cleanText = (s, n) => String(s ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, n);

export async function isBlockedEitherWay(x, y) {
  const { contactBlocks } = await chatDb();
  const a = normEmail(x), b = normEmail(y);
  return !!(await contactBlocks.findOne({ $or: [{ blocker: a, blocked: b }, { blocker: b, blocked: a }] }));
}

async function isOrgMember(orgId, email) {
  const { orgMembers } = await getOrgCollections();
  return !!(await orgMembers.findOne({ orgId: new ObjectId(orgId), email: normEmail(email), status: "active" }));
}

async function orgAllowsExternal(orgId) {
  const { orgs } = await getOrgCollections();
  const o = await orgs.findOne({ _id: new ObjectId(orgId) }, { projection: { chatSettings: 1 } });
  return !!o?.chatSettings?.allowExternal;
}

/** People the caller can start a conversation with: members of the same organization. Nothing about other tenants. */
export async function searchPeople({ orgId, email, q }) {
  const me = normEmail(email);
  const needle = String(q || "").trim().toLowerCase();
  if (needle.length < 2) return [];
  const { orgMembers } = await getOrgCollections();
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rows = await orgMembers.find({ orgId: new ObjectId(orgId), status: "active", email: { $regex: esc, $options: "i" } }).project({ email: 1 }).limit(40).toArray();
  const out = [];
  for (const r of rows) {
    const e = normEmail(r.email); if (e === me) continue;
    if (await isBlockedEitherWay(me, e)) continue;
    out.push({ email: e, relation: "member" });
    if (out.length >= 20) break;
  }
  return out;
}

export async function requestContact({ orgId, email, toEmail, purpose }) {
  const from = normEmail(email), to = normEmail(toEmail);
  if (!EMAIL.test(to)) fail(400, "Enter a valid email address.");
  if (from === to) fail(400, "You cannot add yourself.");
  const rl = await slidingWindowCheck({ action: "chat:contact-request", key: `${orgId}:${from}`, max: LIMITS.contactRequestsPerHour, windowMs: 3600_000 });
  if (!rl.allowed) fail(429, "Too many contact requests. Try again later.", "RATE_LIMITED");
  const member = await isOrgMember(orgId, to);
  if (!member && !(await orgAllowsExternal(orgId))) fail(403, "Your organization does not allow contacts outside it.", "EXTERNAL_DISABLED");
  const cleanPurpose = cleanText(purpose, 140);
  if (!member && !cleanPurpose) fail(400, "Say why you want to connect (shown to the other person).", "PURPOSE_REQUIRED");
  const { contactRequests, contacts, contactBlocks } = await chatDb();
  const [a, b] = pair(from, to);
  if (await contacts.findOne({ orgId: String(orgId), a, b })) return { status: "already-contacts" };
  // Blocked by the target: pretend it was sent. The response is identical either way.
  if (await contactBlocks.findOne({ blocker: to, blocked: from })) return { status: "sent" };
  if (await contactBlocks.findOne({ blocker: from, blocked: to })) fail(409, "Unblock this person first.", "BLOCKED_BY_YOU");
  const reverse = await contactRequests.findOne({ from: to, to: from, status: "pending" });
  if (reverse) { await acceptRequest({ email: from, requestId: String(reverse._id) }); return { status: "accepted" }; }
  const dup = await contactRequests.findOne({ orgId: String(orgId), from, to, status: "pending" });
  if (dup) return { status: "sent", requestId: String(dup._id) };
  const now = nowIso();
  const ins = await contactRequests.insertOne({ orgId: String(orgId), from, to, purpose: cleanPurpose || null, status: "pending", createdAt: now, expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString() });
  await logOrgActivity({ orgId, recordType: "CHAT_CONTACT", recordId: ins.insertedId, actorEmail: from, action: "REQUESTED", previousState: null, newState: null, metadata: { internal: member } });
  if (member) {
    try { await createNotification({ scope: "org", orgId, targetEmail: to, category: "business", type: "chat.contact_request", title: "New secure contact request", body: "Open Secure Chat to respond.", sourceModule: "chat", sourceId: ins.insertedId, actionUrl: "/business?view=chat", metadata: {}, dedupeKey: `chat:creq:${ins.insertedId}` }); } catch { /* best effort */ }
  }
  return { status: "sent", requestId: String(ins.insertedId) };
}

export async function listContacts({ orgId, email }) {
  const me = normEmail(email);
  const { contacts, contactRequests, contactBlocks } = await chatDb();
  const [mine, incoming, outgoing, blocks] = await Promise.all([
    contacts.find({ $or: [{ a: me }, { b: me }] }).limit(500).toArray(),
    contactRequests.find({ to: me, status: "pending" }).sort({ createdAt: -1 }).limit(100).toArray(),
    contactRequests.find({ from: me, status: "pending" }).sort({ createdAt: -1 }).limit(100).toArray(),
    contactBlocks.find({ blocker: me }).limit(500).toArray(),
  ]);
  return {
    contacts: mine.map((c) => ({ id: String(c._id), email: c.a === me ? c.b : c.a, since: c.createdAt })),
    incoming: incoming.map((r) => ({ id: String(r._id), from: r.from, purpose: r.purpose, createdAt: r.createdAt })),
    outgoing: outgoing.map((r) => ({ id: String(r._id), to: r.to, purpose: r.purpose, createdAt: r.createdAt })),
    blocked: blocks.map((b) => ({ email: b.blocked, since: b.createdAt })),
  };
}

export async function acceptRequest({ email, requestId }) {
  if (!ObjectId.isValid(requestId)) fail(404, "Request not found.");
  const me = normEmail(email);
  const { contactRequests, contacts, contactBlocks } = await chatDb();
  const r = await contactRequests.findOneAndUpdate({ _id: new ObjectId(requestId), to: me, status: "pending", expiresAt: { $gt: nowIso() } }, { $set: { status: "accepted", decidedAt: nowIso() } }, { returnDocument: "after" });
  if (!r) fail(404, "Request not found.");
  if (await contactBlocks.findOne({ $or: [{ blocker: r.from, blocked: me }, { blocker: me, blocked: r.from }] })) fail(409, "This request can no longer be accepted.");
  const [a, b] = pair(r.from, r.to);
  await contacts.updateOne({ orgId: r.orgId, a, b }, { $setOnInsert: { orgId: r.orgId, a, b, createdAt: nowIso() } }, { upsert: true });
  await logOrgActivity({ orgId: r.orgId, recordType: "CHAT_CONTACT", recordId: r._id, actorEmail: me, action: "ACCEPTED", previousState: null, newState: null, metadata: {} });
  return { status: "accepted", with: r.from };
}

export async function denyRequest({ email, requestId }) {
  if (!ObjectId.isValid(requestId)) fail(404, "Request not found.");
  const { contactRequests } = await chatDb();
  const r = await contactRequests.findOneAndUpdate({ _id: new ObjectId(requestId), to: normEmail(email), status: "pending" }, { $set: { status: "denied", decidedAt: nowIso() } }, { returnDocument: "after" });
  if (!r) fail(404, "Request not found.");
  return { status: "denied" };
}

export async function cancelRequest({ email, requestId }) {
  if (!ObjectId.isValid(requestId)) fail(404, "Request not found.");
  const { contactRequests } = await chatDb();
  const r = await contactRequests.findOneAndUpdate({ _id: new ObjectId(requestId), from: normEmail(email), status: "pending" }, { $set: { status: "cancelled", decidedAt: nowIso() } }, { returnDocument: "after" });
  if (!r) fail(404, "Request not found.");
  return { status: "cancelled" };
}

export async function removeContact({ email, contactId }) {
  if (!ObjectId.isValid(contactId)) fail(404, "Contact not found.");
  const me = normEmail(email);
  const { contacts } = await chatDb();
  const r = await contacts.deleteOne({ _id: new ObjectId(contactId), $or: [{ a: me }, { b: me }] });
  if (!r.deletedCount) fail(404, "Contact not found.");
  return { removed: true };
}

/** Block by email (also removes the contact and cancels pending requests either way). */
export async function blockPerson({ orgId, email, target }) {
  const me = normEmail(email), t = normEmail(target);
  if (!EMAIL.test(t) || me === t) fail(400, "Enter another person's email address.");
  const { contactBlocks, contacts, contactRequests } = await chatDb();
  await contactBlocks.updateOne({ blocker: me, blocked: t }, { $setOnInsert: { blocker: me, blocked: t, createdAt: nowIso() } }, { upsert: true });
  const [a, b] = pair(me, t);
  await contacts.deleteMany({ a, b });
  await contactRequests.updateMany({ status: "pending", $or: [{ from: me, to: t }, { from: t, to: me }] }, { $set: { status: "cancelled", decidedAt: nowIso() } });
  await logOrgActivity({ orgId, recordType: "CHAT_CONTACT", recordId: new ObjectId(), actorEmail: me, action: "BLOCKED", previousState: null, newState: null, metadata: {} });
  return { blocked: true };
}

export async function unblockPerson({ email, target }) {
  const { contactBlocks } = await chatDb();
  await contactBlocks.deleteOne({ blocker: normEmail(email), blocked: normEmail(target) });
  return { blocked: false };
}
