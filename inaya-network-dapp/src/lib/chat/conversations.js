// src/lib/chat/conversations.js
//
// Conversations, participants, commits (membership changes), messages, read state and sync (SOW A1, A3, A4, A7, A10).
//
// Authority model (see the ADR):
//   * The participant LIST (owner/admin managed, server enforced) says who SHOULD be in the MLS group.
//   * Membership changes in the cryptographic group are made by clients as MLS commits. The server accepts a commit only if
//     it matches the PLAN derived from the participant list and device status: Adds are limited to active devices of
//     active/pending participants that are not yet leaves; Removes are limited to leaves whose device is revoked or whose
//     owner is no longer a participant. Anything else is refused, so a malicious member cannot slip in a rogue device.
//   * Application messages are refused while a Remove is pending (409 RECONCILE_REQUIRED), so a message is never encrypted
//     to an epoch that still contains a removed or revoked device.
// The server stores and orders opaque ciphertext; it never decrypts anything.

import { ObjectId } from "mongodb";
import { connectToDatabase } from "../mongodb.js";
import { canManageOrg } from "../orgs.js";
import { slidingWindowCheck } from "../rateLimit.js";
import { logOrgActivity } from "../org-activity-log.js";
import { createNotification } from "../notifications.js";
import { LIMITS, b64, chatDb, fail, getOrgCollections, isId, nowIso, normEmail, recordSecurityEvent } from "./common.js";
import { applyLeafChanges, inspectCommit, inspectPrivateMessage, inspectWelcome, keyPackageRefHex } from "./mlsServer.js";
import { claimKeyPackagesForDevices, getActiveDevice, touchDevice } from "./devices.js";
import { isBlockedEitherWay } from "./contacts.js";

const KINDS = ["direct", "group", "org"];
const SUBS = ["msg", "edit", "delete", "rename", "meta"];
const oid = (id) => new ObjectId(id);

/** Run fn inside a Mongo transaction (needed so seq allocation and the insert it belongs to are atomic and ordered). */
export async function withTxn(fn) {
  const { client } = await connectToDatabase();
  const session = client.startSession();
  try {
    let result;
    await session.withTransaction(async () => { result = await fn(session); }, { readPreference: "primary", readConcern: { level: "local" }, writeConcern: { w: "majority" } });
    return result;
  } finally { await session.endSession(); }
}

// ---------------------------------------------------------------------------------------------------- access

/** Loads the conversation and the caller's participant row. Fails closed with a generic 404 (never says which part was
 *  wrong) so conversation ids cannot be probed across tenants. */
export async function assertAccess({ orgId, email, conversationId, statuses = ["active", "pending"] }) {
  if (!isId(conversationId)) fail(404, "Conversation not found.");
  const { conversations, participants } = await chatDb();
  const conv = await conversations.findOne({ _id: conversationId });
  const participant = conv ? await participants.findOne({ conversationId, email: normEmail(email), status: { $in: statuses } }) : null;
  if (!conv || !participant) fail(404, "Conversation not found.");
  if (conv.orgId !== String(orgId) && !participant.external) fail(404, "Conversation not found.");
  return { conv, participant };
}

const canManageConversation = (conv, participant, membership) =>
  participant.role === "owner" || participant.role === "admin" || (conv.kind === "org" && canManageOrg(membership));

// ---------------------------------------------------------------------------------------------------- views

function publicParticipant(p, devicesByEmail) {
  return {
    email: p.email, role: p.role, status: p.status, external: !!p.external, joinedAt: p.joinedAt || null, leftAt: p.leftAt || null,
    devices: (devicesByEmail?.get(p.email) || []).map((d) => ({ deviceId: d.deviceId, platform: d.platform, fingerprint: d.fingerprint })),
  };
}

export async function conversationPlan(conv) {
  const { participants, devices } = await chatDb();
  const parts = await participants.find({ conversationId: conv._id, status: { $in: ["active", "pending"] } }).toArray();
  const emails = parts.map((p) => p.email);
  const leafIds = conv.leaves.filter(Boolean);
  const [expectedDevices, leafDevices] = await Promise.all([
    devices.find({ email: { $in: emails }, status: "active" }).toArray(),
    leafIds.length ? devices.find({ deviceId: { $in: leafIds } }).toArray() : [],
  ]);
  // Non-external participants only count with devices enrolled in this organization; an external participant's devices
  // live in their own organization.
  const extEmails = new Set(parts.filter((p) => p.external).map((p) => p.email));
  const expected = expectedDevices.filter((d) => d.orgId === conv.orgId || extEmails.has(d.email));
  const inGroup = new Set(leafIds);
  const adds = expected.filter((d) => !inGroup.has(d.deviceId)).map((d) => ({ email: d.email, deviceId: d.deviceId }));
  const byId = new Map(leafDevices.map((d) => [d.deviceId, d]));
  const emailSet = new Set(emails);
  const removes = [];
  conv.leaves.forEach((deviceId, leafIndex) => {
    if (!deviceId) return;
    const d = byId.get(deviceId);
    if (!d || d.status === "revoked" || !emailSet.has(d.email)) removes.push({ leafIndex, deviceId, email: d?.email || null, reason: !d ? "unknown" : d.status === "revoked" ? "revoked" : "not-a-participant" });
  });
  const haveDevice = new Set(expected.map((d) => d.email));
  const noDevices = parts.filter((p) => !haveDevice.has(p.email)).map((p) => p.email);
  return { adds, removes, noDevices, epoch: conv.epoch };
}

export async function viewConversation({ conv, participant }) {
  const { participants, devices, readStates, messages } = await chatDb();
  const parts = await participants.find({ conversationId: conv._id, status: { $in: ["active", "pending"] } }).toArray();
  const devs = await devices.find({ email: { $in: parts.map((p) => p.email) }, status: "active" }).toArray();
  const byEmail = new Map(); for (const d of devs) { if (!byEmail.has(d.email)) byEmail.set(d.email, []); byEmail.get(d.email).push(d); }
  const rs = await readStates.findOne({ conversationId: conv._id, email: participant.email });
  const readSeq = Math.max(rs?.readSeq || 0, participant.joinSeq || 0);
  const unread = await messages.countDocuments({ conversationId: conv._id, seq: { $gt: readSeq }, kind: "app", sub: "msg", senderEmail: { $ne: participant.email }, purged: { $ne: true } });
  return {
    id: conv._id, orgId: conv.orgId, kind: conv.kind, status: conv.status, createdBy: conv.createdBy, createdAt: conv.createdAt, updatedAt: conv.updatedAt,
    epoch: conv.epoch, lastSeq: conv.lastSeq, lastMessageAt: conv.lastMessageAt || null, lastMessageSize: conv.lastMessageSize ?? null, external: !!conv.external,
    me: { role: participant.role, status: participant.status, muted: !!participant.muted, archived: !!participant.archived, hidden: !!participant.hidden, joinSeq: participant.joinSeq || 0, readSeq, lastFocusAt: participant.lastFocusAt || null },
    unread,
    participants: parts.map((p) => publicParticipant(p, byEmail)),
  };
}

// ---------------------------------------------------------------------------------------------------- creation

async function memberOfOrg(orgId, email) {
  const { orgMembers } = await getOrgCollections();
  return orgMembers.findOne({ orgId: new ObjectId(orgId), email: normEmail(email), status: "active" });
}

async function orgAllowsExternal(orgId) {
  const { orgs } = await getOrgCollections();
  const o = await orgs.findOne({ _id: new ObjectId(orgId) }, { projection: { chatSettings: 1 } });
  return !!o?.chatSettings?.allowExternal;
}

export async function getChatSettings(orgId) {
  const { orgs } = await getOrgCollections();
  const o = await orgs.findOne({ _id: new ObjectId(orgId) }, { projection: { chatSettings: 1 } });
  return { allowExternal: !!o?.chatSettings?.allowExternal, allowEditing: o?.chatSettings?.allowEditing !== false, allowDeleting: o?.chatSettings?.allowDeleting !== false };
}

export async function setChatSettings({ orgId, membership, actorEmail, patch }) {
  if (!canManageOrg(membership)) fail(403, "Only the owner or an admin can change chat settings.");
  const { orgs } = await getOrgCollections();
  const set = {};
  for (const k of ["allowExternal", "allowEditing", "allowDeleting"]) if (typeof patch?.[k] === "boolean") set[`chatSettings.${k}`] = patch[k];
  if (!Object.keys(set).length) fail(400, "Nothing to change.");
  await orgs.updateOne({ _id: new ObjectId(orgId) }, { $set: set });
  await logOrgActivity({ orgId, recordType: "CHAT_SETTINGS", recordId: orgId, actorEmail, action: "UPDATED", previousState: null, newState: set, metadata: {} });
  return getChatSettings(orgId);
}

async function resolveInvitees({ orgId, creatorEmail, emails, external }) {
  const list = [...new Set((emails || []).map(normEmail).filter(Boolean))].filter((e) => e !== normEmail(creatorEmail));
  const out = [];
  const { contacts } = await chatDb();
  for (const email of list) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(400, "One of the participants is not a valid email address.");
    if (await isBlockedEitherWay(creatorEmail, email)) fail(403, "You cannot start a conversation with one of these people.");
    const member = await memberOfOrg(orgId, email);
    if (member) { out.push({ email, external: false }); continue; }
    if (!external) fail(403, "Everyone must be a member of the organization.", "NOT_A_MEMBER");
    if (!(await orgAllowsExternal(orgId))) fail(403, "This organization does not allow conversations with people outside it.", "EXTERNAL_DISABLED");
    const [a, b] = [normEmail(creatorEmail), email].sort();
    if (!(await contacts.findOne({ orgId: String(orgId), a, b }))) fail(403, "External people must first accept a contact request.", "NOT_A_CONTACT");
    out.push({ email, external: true });
  }
  return out;
}

export async function createConversation({ orgId, membership, email, deviceId, conversationId, kind, emails, external = false }) {
  const em = normEmail(email);
  if (!KINDS.includes(kind)) fail(400, "kind must be direct, group or org.");
  if (!isId(conversationId)) fail(400, "conversationId must be 24 hex characters (the MLS group id).");
  const dev = await getActiveDevice({ orgId, email: em, deviceId });
  if (!dev || dev.status !== "active") fail(403, "Enroll this device and publish KeyPackages before chatting.", "DEVICE_NOT_READY");
  const rl = await slidingWindowCheck({ action: "chat:create", key: `${orgId}:${em}`, max: LIMITS.conversationsPerHour, windowMs: 3600_000 });
  if (!rl.allowed) fail(429, "You are creating conversations too quickly.", "RATE_LIMITED");

  let invitees;
  if (kind === "org") {
    if (!canManageOrg(membership)) fail(403, "Only the owner or an admin can create an organization conversation.");
    const { orgMembers } = await getOrgCollections();
    const all = await orgMembers.find({ orgId: new ObjectId(orgId), status: "active" }).project({ email: 1 }).limit(LIMITS.maxParticipants + 1).toArray();
    if (all.length > LIMITS.maxParticipants) fail(409, `Organization conversations are limited to ${LIMITS.maxParticipants} members.`);
    invitees = all.map((m) => ({ email: normEmail(m.email), external: false })).filter((m) => m.email !== em);
  } else {
    invitees = await resolveInvitees({ orgId, creatorEmail: em, emails, external: kind !== "direct" ? external : external });
    if (kind === "direct" && invitees.length !== 1) fail(400, "A direct conversation has exactly one other person.");
    if (kind === "group" && invitees.length < 1) fail(400, "Pick at least one other person.");
    if (invitees.length + 1 > LIMITS.maxParticipants) fail(409, `Conversations are limited to ${LIMITS.maxParticipants} people.`);
  }
  const { conversations, participants } = await chatDb();
  const dedupeKey = kind === "direct" ? [em, invitees[0].email].sort().join("|") : null;
  if (dedupeKey) {
    const existing = await conversations.findOne({ orgId: String(orgId), dedupeKey, status: "active" });
    if (existing) { const p = await participants.findOne({ conversationId: existing._id, email: em }); if (p) return { existed: true, conversation: await viewConversation({ conv: existing, participant: p }) }; }
  }
  const now = nowIso();
  const conv = {
    _id: conversationId, orgId: String(orgId), kind, dedupeKey, createdBy: em, createdAt: now, updatedAt: now, status: "active",
    epoch: 0, lastSeq: 0, leaves: [deviceId], external: invitees.some((i) => i.external), lastMessageAt: null, lastMessageSize: null,
  };
  try { await conversations.insertOne(conv); }
  catch (err) { if (err?.code === 11000) fail(409, "That conversation already exists.", "CONFLICT"); throw err; }
  const rows = [{ conversationId, orgId: String(orgId), email: em, role: "owner", status: "active", external: false, joinedAt: now, joinSeq: 0, muted: false, archived: false, addedBy: em },
    ...invitees.map((i) => ({ conversationId, orgId: String(orgId), email: i.email, role: "member", status: "pending", external: i.external, joinedAt: null, joinSeq: null, muted: false, archived: false, addedBy: em }))];
  await participants.insertMany(rows);
  await logOrgActivity({ orgId, recordType: "CHAT_CONVERSATION", recordId: conversationId, actorEmail: em, action: "CREATED", previousState: null, newState: null, metadata: { kind, participants: rows.length } });
  const p = rows[0];
  return { existed: false, conversation: await viewConversation({ conv, participant: p }) };
}

// ---------------------------------------------------------------------------------------------------- participants

export async function addParticipants({ orgId, membership, email, conversationId, emails, external = false }) {
  const { conv, participant } = await assertAccess({ orgId, email, conversationId, statuses: ["active"] });
  if (conv.status !== "active") fail(404, "Conversation not found.");
  if (conv.kind === "direct") fail(400, "A direct conversation always has exactly two people.");
  if (!canManageConversation(conv, participant, membership)) fail(403, "Only a conversation owner or admin can add people.");
  const invitees = await resolveInvitees({ orgId: conv.orgId, creatorEmail: email, emails, external });
  const { participants, conversations } = await chatDb();
  const current = await participants.countDocuments({ conversationId, status: { $in: ["active", "pending"] } });
  const fresh = []; for (const i of invitees) { const ex = await participants.findOne({ conversationId, email: i.email }); if (!ex || !["active", "pending"].includes(ex.status)) fresh.push(i); }
  if (current + fresh.length > LIMITS.maxParticipants) fail(409, `Conversations are limited to ${LIMITS.maxParticipants} people.`);
  const now = nowIso();
  for (const i of fresh) {
    await participants.updateOne({ conversationId, email: i.email },
      { $set: { status: "pending", external: i.external, role: "member", joinedAt: null, joinSeq: null, leftAt: null, removedAtSeq: null, addedBy: normEmail(email), muted: false, archived: false, hidden: false, orgId: conv.orgId },
        $setOnInsert: { conversationId, email: i.email } }, { upsert: true });
  }
  if (fresh.some((f) => f.external)) await conversations.updateOne({ _id: conversationId }, { $set: { external: true } });
  await conversations.updateOne({ _id: conversationId }, { $set: { updatedAt: now } });
  await logOrgActivity({ orgId: conv.orgId, recordType: "CHAT_CONVERSATION", recordId: conversationId, actorEmail: email, action: "PARTICIPANTS_ADDED", previousState: null, newState: null, metadata: { count: fresh.length } });
  for (const i of fresh) await notifyChat({ conv, toEmail: i.email, type: "chat.participant_added", title: "You were added to a secure conversation", dedupe: `chat:added:${conversationId}:${i.email}:${Date.now()}` });
  return { added: fresh.map((f) => f.email) };
}

async function transferOwnerIfNeeded(conv, leavingEmail) {
  const { participants } = await chatDb();
  const leaving = await participants.findOne({ conversationId: conv._id, email: leavingEmail });
  if (!leaving || leaving.role !== "owner") return;
  const next = await participants.find({ conversationId: conv._id, status: { $in: ["active", "pending"] }, email: { $ne: leavingEmail } }).sort({ role: 1, joinedAt: 1 }).limit(1).next();
  if (next) await participants.updateOne({ _id: next._id }, { $set: { role: "owner" } });
}

export async function removeParticipant({ orgId, membership, email, conversationId, targetEmail }) {
  const { conv, participant } = await assertAccess({ orgId, email, conversationId, statuses: ["active"] });
  const target = normEmail(targetEmail);
  if (conv.kind === "direct") fail(400, "You cannot remove someone from a direct conversation. Leave or delete it instead.");
  if (!canManageConversation(conv, participant, membership)) fail(403, "Only a conversation owner or admin can remove people.");
  const { participants, conversations } = await chatDb();
  const t = await participants.findOne({ conversationId, email: target, status: { $in: ["active", "pending"] } });
  if (!t) fail(404, "That person is not in this conversation.");
  if (t.role === "owner" && participant.role !== "owner") fail(403, "Only the owner can remove the owner.");
  if (target === normEmail(email)) fail(400, "Use leave to leave a conversation.");
  const fresh = await conversations.findOneAndUpdate({ _id: conversationId }, { $set: { updatedAt: nowIso() } }, { returnDocument: "after" });
  // From this instant the server refuses every read and send for the removed person; the cryptographic removal (new epoch)
  // follows as soon as any member's client executes the Remove commit, and sends are blocked until it has.
  await participants.updateOne({ _id: t._id }, { $set: { status: "removed", leftAt: nowIso(), removedAtSeq: fresh.lastSeq, removedBy: normEmail(email) } });
  await logOrgActivity({ orgId: conv.orgId, recordType: "CHAT_CONVERSATION", recordId: conversationId, actorEmail: email, action: "PARTICIPANT_REMOVED", previousState: null, newState: null, metadata: {} });
  await recordSecurityEvent({ orgId: conv.orgId, email: target, conversationId, type: "PARTICIPANT_REMOVED", detail: `by ${normEmail(email)}` });
  await notifyChat({ conv, toEmail: target, type: "chat.participant_removed", title: "You were removed from a secure conversation", dedupe: `chat:removed:${conversationId}:${target}:${Date.now()}` });
  return { removed: target };
}

export async function leaveConversation({ orgId, email, conversationId }) {
  const { conv } = await assertAccess({ orgId, email, conversationId, statuses: ["active", "pending"] });
  const em = normEmail(email);
  const { participants, conversations } = await chatDb();
  await transferOwnerIfNeeded(conv, em);
  const fresh = await conversations.findOneAndUpdate({ _id: conversationId }, { $set: { updatedAt: nowIso() } }, { returnDocument: "after" });
  await participants.updateOne({ conversationId, email: em }, { $set: { status: "left", leftAt: nowIso(), removedAtSeq: fresh.lastSeq } });
  await logOrgActivity({ orgId: conv.orgId, recordType: "CHAT_CONVERSATION", recordId: conversationId, actorEmail: em, action: "LEFT", previousState: null, newState: null, metadata: {} });
  return { left: true };
}

export async function deleteConversation({ orgId, membership, email, conversationId }) {
  const { conv, participant } = await assertAccess({ orgId, email, conversationId, statuses: ["active", "pending", "left"] });
  const { participants, conversations, messages, envelopes, attachments, db } = await chatDb();
  const em = normEmail(email);
  // Anyone may delete a conversation FOR THEMSELVES. Only an owner/admin (or either person of a direct chat) deletes it for everyone.
  const forAll = conv.kind === "direct" || canManageConversation(conv, participant, membership);
  if (!forAll || participant.status === "left") {
    await participants.updateOne({ conversationId, email: em }, { $set: { hidden: true, archived: true } });
    return { deleted: "for-me" };
  }
  const now = nowIso();
  await conversations.updateOne({ _id: conversationId }, { $set: { status: "deleted", deletedAt: now, deletedBy: em, updatedAt: now } });
  await messages.updateMany({ conversationId }, { $set: { ciphertext: null, commit: null, purged: true } });
  await envelopes.deleteMany({ conversationId });
  await attachments.updateMany({ conversationId }, { $set: { purged: true } });
  await db.collection("chat_blob_parts").deleteMany({ conversationId });
  await participants.updateMany({ conversationId, status: { $in: ["active", "pending"] } }, { $set: { status: "removed", leftAt: now } });
  await logOrgActivity({ orgId: conv.orgId, recordType: "CHAT_CONVERSATION", recordId: conversationId, actorEmail: em, action: "DELETED", previousState: null, newState: null, metadata: { kind: conv.kind } });
  return { deleted: "for-everyone" };
}

export async function updateMyState({ orgId, email, conversationId, patch }) {
  const { participant } = await assertAccess({ orgId, email, conversationId, statuses: ["active", "pending", "left"] });
  const set = {};
  for (const k of ["muted", "archived"]) if (typeof patch?.[k] === "boolean") set[k] = patch[k];
  if (patch?.archived === false) set.hidden = false;
  if (!Object.keys(set).length) fail(400, "Nothing to change.");
  const { participants } = await chatDb();
  await participants.updateOne({ _id: participant._id }, { $set: set });
  return set;
}

// ---------------------------------------------------------------------------------------------------- commits

/** Accept one MLS commit (membership change / key rotation) if and only if it matches the server-computed plan. */
export async function submitCommit({ orgId, email, deviceId, conversationId, baseEpoch, commit, welcome, clientCommitId }) {
  const em = normEmail(email);
  const { conv, participant } = await assertAccess({ orgId, email: em, conversationId, statuses: ["active"] });
  if (conv.status !== "active") fail(404, "Conversation not found.");
  const dev = await getActiveDevice({ orgId, email: em, deviceId });
  if (!dev) fail(403, "Unknown or revoked device.", "DEVICE_REVOKED");
  const leafIndexOfCommitter = conv.leaves.indexOf(deviceId);
  if (leafIndexOfCommitter < 0) fail(403, "This device is not part of the conversation's encrypted group.", "NOT_IN_GROUP");
  if (!Number.isInteger(baseEpoch) || baseEpoch !== conv.epoch) fail(409, "The conversation moved on. Sync and try again.", "STALE_EPOCH");
  const commitBytes = b64.dec(commit);
  if (commitBytes.length > LIMITS.maxCommitBytes) fail(413, "Commit too large.");
  const info = inspectCommit(commitBytes);
  if (info.groupIdHex !== conversationId) { await recordSecurityEvent({ orgId, email: em, deviceId, conversationId, type: "COMMIT_WRONG_GROUP" }); fail(400, "Commit is for a different conversation.", "WRONG_GROUP"); }
  if (info.epoch !== conv.epoch) fail(409, "The conversation moved on. Sync and try again.", "STALE_EPOCH");
  if (info.senderLeaf !== leafIndexOfCommitter) { await recordSecurityEvent({ orgId, email: em, deviceId, conversationId, type: "COMMIT_SENDER_MISMATCH" }); fail(403, "The commit was not made by this device.", "SENDER_MISMATCH"); }
  if (info.other) fail(400, "Only Add and Remove proposals are allowed.", "BAD_PROPOSAL");
  if (info.hasPath && info.pathIdentity && info.pathIdentity.deviceId !== deviceId) fail(403, "The commit's update path belongs to another device.", "SENDER_MISMATCH");

  const plan = await conversationPlan(conv);
  const planAdd = new Map(plan.adds.map((a) => [a.deviceId, a]));
  const planRemove = new Set(plan.removes.map((r) => r.leafIndex));

  // Removes must be in the plan.
  for (const r of info.removes) if (!planRemove.has(r)) { await recordSecurityEvent({ orgId, email: em, deviceId, conversationId, type: "COMMIT_ILLEGAL_REMOVE" }); fail(403, "That removal is not authorized.", "ILLEGAL_REMOVE"); }
  if (new Set(info.removes).size !== info.removes.length) fail(400, "Duplicate removal.");

  // Adds must be plan devices whose KeyPackage this committer claimed for this conversation.
  const { keyPackages, envelopes, conversations, participants, messages } = await chatDb();
  const addDeviceIds = []; const addRefs = []; const claimRows = [];
  for (const kp of info.adds) {
    const ref = await keyPackageRefHex(kp);
    const row = await keyPackages.findOne({ refHex: ref });
    const ident = Buffer.from(kp.leafNode.credential.identity).toString("utf8").split(":");
    const addDevice = ident[4];
    if (!row || row.deviceId !== addDevice || !planAdd.has(addDevice)) { await recordSecurityEvent({ orgId, email: em, deviceId, conversationId, type: "COMMIT_ILLEGAL_ADD" }); fail(403, "That addition is not authorized.", "ILLEGAL_ADD"); }
    if (!row.lastResort && !(row.status === "claimed" && row.claimedByConversation === conversationId && row.claimedByDevice === deviceId)) fail(403, "That KeyPackage was not issued to you for this conversation.", "KP_NOT_CLAIMED");
    if (!row.lastResort && Date.now() - new Date(row.claimedAt).getTime() > 15 * 60_000) fail(409, "The KeyPackage claim expired. Claim again.", "KP_CLAIM_EXPIRED");
    addDeviceIds.push(addDevice); addRefs.push(ref); claimRows.push(row);
  }
  if (new Set(addDeviceIds).size !== addDeviceIds.length) fail(400, "Duplicate addition.");
  if (info.adds.length) {
    if (!welcome) fail(400, "A Welcome is required when adding devices.", "WELCOME_REQUIRED");
    const wBytes = b64.dec(welcome); if (wBytes.length > LIMITS.maxWelcomeBytes) fail(413, "Welcome too large.");
    const w = inspectWelcome(wBytes);
    if (w.recipientRefHexes.length !== addRefs.length || !addRefs.every((r) => w.recipientRefHexes.includes(r))) fail(400, "The Welcome does not match the added devices.", "WELCOME_MISMATCH");
  } else if (welcome) fail(400, "A Welcome was supplied without additions.");

  const newLeaves = applyLeafChanges(conv.leaves, { removes: info.removes, addDeviceIds });
  const newEpoch = conv.epoch + 1;
  const now = nowIso();

  const result = await withTxn(async (session) => {
    const updated = await conversations.findOneAndUpdate(
      { _id: conversationId, status: "active", epoch: conv.epoch },
      { $inc: { lastSeq: 1 }, $set: { epoch: newEpoch, leaves: newLeaves, updatedAt: now } }, { returnDocument: "after", session });
    if (!updated) return null;
    const seq = updated.lastSeq;
    await messages.insertOne({ conversationId, seq, epoch: conv.epoch, kind: "commit", sub: null, senderEmail: em, senderDeviceId: deviceId, clientMsgId: clientCommitId ? String(clientCommitId).slice(0, 64) : null,
      commit: commit, ciphertext: null, size: commitBytes.length, createdAt: now, adds: addDeviceIds, removes: info.removes.length }, { session });
    for (let i = 0; i < addDeviceIds.length; i++) {
      await envelopes.insertOne({ conversationId, epoch: newEpoch, seq, recipientDeviceId: addDeviceIds[i], welcome, createdAt: now, consumedAt: null }, { session });
      if (!claimRows[i].lastResort) await keyPackages.updateOne({ refHex: addRefs[i] }, { $set: { status: "used", usedAt: now } }, { session });
    }
    // Participants whose first device just joined become active from this seq on (they cannot read anything earlier).
    const joinedEmails = new Set(); for (const d of addDeviceIds) joinedEmails.add(planAdd.get(d).email);
    for (const e of joinedEmails) await participants.updateOne({ conversationId, email: e, status: "pending" }, { $set: { status: "active", joinedAt: now, joinSeq: seq } }, { session });
    return { seq, epoch: newEpoch };
  });
  if (!result) fail(409, "The conversation moved on. Sync and try again.", "STALE_EPOCH");
  await touchDevice(deviceId);
  await logOrgActivity({ orgId: conv.orgId, recordType: "CHAT_CONVERSATION", recordId: conversationId, actorEmail: em, action: "EPOCH_ADVANCED", previousState: { epoch: conv.epoch }, newState: { epoch: newEpoch }, metadata: { adds: addDeviceIds.length, removes: info.removes.length } });
  return { ...result, adds: addDeviceIds.length, removes: info.removes.length };
}

/** A member's device asks for KeyPackages of the devices in the plan it is about to add. */
export async function claimForCommit({ orgId, email, deviceId, conversationId, deviceIds }) {
  const { conv } = await assertAccess({ orgId, email, conversationId, statuses: ["active"] });
  if (!(await getActiveDevice({ orgId, email, deviceId }))) fail(403, "Unknown or revoked device.", "DEVICE_REVOKED");
  if (!conv.leaves.includes(deviceId)) fail(403, "This device is not part of the conversation's encrypted group.", "NOT_IN_GROUP");
  if (!Array.isArray(deviceIds) || !deviceIds.length || deviceIds.length > 100) fail(400, "deviceIds is required (at most 100).");
  const plan = await conversationPlan(conv);
  const allowed = new Set(plan.adds.map((a) => a.deviceId));
  for (const d of deviceIds) if (!allowed.has(d)) fail(403, "That device is not waiting to be added to this conversation.", "NOT_IN_PLAN");
  return claimKeyPackagesForDevices({ deviceIds, conversationId, claimerDeviceId: deviceId });
}

// ---------------------------------------------------------------------------------------------------- messages

/** Allowed participant statuses for reading, and the highest seq they may see. */
function readWindow(participant) {
  const from = participant.joinSeq || 0;
  const to = participant.status === "active" || participant.status === "pending" ? Infinity : (participant.removedAtSeq ?? 0);
  return { from, to };
}

export async function submitMessage({ orgId, membership = null, email, deviceId, conversationId, clientMsgId, sub = "msg", ciphertext, targetMessageId = null }) {
  const em = normEmail(email);
  if (!SUBS.includes(sub)) fail(400, "Unknown message kind.");
  if (typeof clientMsgId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(clientMsgId)) fail(400, "clientMsgId is required (8-64 URL-safe characters).");
  const rl = await slidingWindowCheck({ action: "chat:send", key: `${orgId}:${em}`, max: LIMITS.messagesPerMinute, windowMs: 60_000 });
  if (!rl.allowed) fail(429, "You are sending messages too quickly.", "RATE_LIMITED");
  const { conv, participant } = await assertAccess({ orgId, email: em, conversationId, statuses: ["active"] });
  if (conv.status !== "active") fail(404, "Conversation not found.");
  const dev = await getActiveDevice({ orgId, email: em, deviceId });
  if (!dev) fail(403, "Unknown or revoked device.", "DEVICE_REVOKED");
  { // A retry of a message the server already stored returns the stored result, even if the epoch has moved on since.
    const { messages: m0 } = await chatDb();
    const dup = await m0.findOne({ conversationId, senderEmail: em, clientMsgId });
    if (dup) return { seq: dup.seq, id: String(dup._id), duplicate: true, epoch: dup.epoch };
  }
  if (!conv.leaves.includes(deviceId)) fail(409, "This device is not in the conversation's encrypted group yet. Sync first.", "NOT_IN_GROUP");
  const bytes = b64.dec(ciphertext);
  if (bytes.length > LIMITS.maxCiphertextBytes) fail(413, "Message too large.", "TOO_LARGE");
  const hdr = inspectPrivateMessage(bytes);
  if (hdr.groupIdHex !== conversationId) { await recordSecurityEvent({ orgId, email: em, deviceId, conversationId, type: "MESSAGE_WRONG_GROUP" }); fail(400, "Message is for a different conversation.", "WRONG_GROUP"); }
  if (hdr.contentType !== "application") fail(400, "Only application messages can be sent here.", "NOT_APPLICATION");
  if (hdr.epoch !== conv.epoch) fail(409, "The conversation moved on. Sync and re-send.", "STALE_EPOCH");

  const plan = await conversationPlan(conv);
  if (plan.removes.length) fail(409, "A member or device is being removed. Sync, apply the removal, then send.", "RECONCILE_REQUIRED");

  const settings = await getChatSettings(conv.orgId);
  const { messages, conversations } = await chatDb();
  let target = null;
  if (sub === "edit" || sub === "delete") {
    if (sub === "edit" && !settings.allowEditing) fail(403, "Editing messages is disabled by your organization.", "POLICY");
    if (sub === "delete" && !settings.allowDeleting) fail(403, "Deleting messages is disabled by your organization.", "POLICY");
    if (!ObjectId.isValid(targetMessageId)) fail(400, "targetMessageId is required.");
    target = await messages.findOne({ _id: oid(targetMessageId), conversationId, kind: "app", sub: "msg" });
    if (!target || target.senderEmail !== em) fail(403, "You can only change your own messages.", "NOT_YOUR_MESSAGE");
    const age = Date.now() - new Date(target.createdAt).getTime();
    if (age > (sub === "edit" ? LIMITS.editWindowMs : LIMITS.deleteWindowMs)) fail(403, "That message is too old to change.", "WINDOW_EXPIRED");
  } else if (sub === "rename" && conv.kind !== "direct" && !canManageConversation(conv, participant, membership)) fail(403, "Only a conversation owner or admin can rename it.", "NOT_ALLOWED");

  const now = nowIso();
  let out;
  try {
    out = await withTxn(async (session) => {
      const updated = await conversations.findOneAndUpdate({ _id: conversationId, status: "active", epoch: conv.epoch }, { $inc: { lastSeq: 1 }, $set: { updatedAt: now, ...(sub === "msg" ? { lastMessageAt: now, lastMessageSize: bytes.length } : {}) } }, { returnDocument: "after", session });
      if (!updated) return null;
      const doc = { conversationId, seq: updated.lastSeq, epoch: conv.epoch, kind: "app", sub, senderEmail: em, senderDeviceId: deviceId, clientMsgId, ciphertext, commit: null, size: bytes.length, createdAt: now, targetMessageId: target ? String(target._id) : null };
      const ins = await messages.insertOne(doc, { session });
      if (sub === "delete" && target) await messages.updateOne({ _id: target._id }, { $set: { ciphertext: null, purged: true, deletedAt: now } }, { session });
      if (sub === "edit" && target) await messages.updateOne({ _id: target._id }, { $set: { editedAt: now } }, { session });
      return { seq: updated.lastSeq, id: String(ins.insertedId), epoch: conv.epoch };
    });
  } catch (err) {
    if (err?.code === 11000) { const d2 = await messages.findOne({ conversationId, senderEmail: em, clientMsgId }); if (d2) return { seq: d2.seq, id: String(d2._id), duplicate: true, epoch: d2.epoch }; }
    throw err;
  }
  if (!out) fail(409, "The conversation moved on. Sync and re-send.", "STALE_EPOCH");
  await touchDevice(deviceId);
  if (sub === "msg") await notifyNewMessage({ conv, fromEmail: em, seq: out.seq });
  // Metadata only, and only to endpoints that explicitly opted in: who sent, which conversation, when. Never the ciphertext, never a title.
  if (sub === "msg" && !out.duplicate) import("../webhooks/registry.js").then((m) => m.emitWebhookEvent({ orgId, type: "chat.metadata", eventId: `chat:${conversationId}:${out.seq}`, data: { conversationId: String(conversationId), seq: out.seq, sender: em } })).catch(() => {});
  return out;
}

export async function listMessages({ orgId, email, deviceId, conversationId, afterSeq = 0, limit = LIMITS.pageSize }) {
  const { conv, participant } = await assertAccess({ orgId, email, conversationId, statuses: ["active", "pending", "left", "removed"] });
  if (participant.status === "pending") return { events: [], lastSeq: conv.lastSeq, epoch: conv.epoch, hasMore: false };
  const dev = await getActiveDevice({ orgId, email, deviceId });
  if (!dev) fail(403, "Unknown or revoked device.", "DEVICE_REVOKED");
  const { messages } = await chatDb();
  const { from, to } = readWindow(participant);
  const after = Math.max(Number(afterSeq) || 0, from);
  const lim = Math.min(Math.max(parseInt(limit, 10) || LIMITS.pageSize, 1), LIMITS.maxPageSize);
  const q = { conversationId, seq: { $gt: after, ...(to === Infinity ? {} : { $lte: to }) } };
  const rows = await messages.find(q).sort({ seq: 1 }).limit(lim + 1).toArray();
  const hasMore = rows.length > lim; if (hasMore) rows.pop();
  await touchDevice(deviceId);
  return {
    epoch: conv.epoch, lastSeq: conv.lastSeq, hasMore,
    events: rows.map((m) => ({ id: String(m._id), seq: m.seq, epoch: m.epoch, kind: m.kind, sub: m.sub, senderEmail: m.senderEmail, senderDeviceId: m.senderDeviceId, createdAt: m.createdAt, size: m.size, targetMessageId: m.targetMessageId || null, purged: !!m.purged, ciphertext: m.kind === "app" ? m.ciphertext : null, commit: m.kind === "commit" ? m.commit : null })),
  };
}

export async function markRead({ orgId, email, conversationId, seq }) {
  const { conv, participant } = await assertAccess({ orgId, email, conversationId, statuses: ["active"] });
  const n = Math.min(Math.max(parseInt(seq, 10) || 0, 0), conv.lastSeq);
  const { readStates, participants } = await chatDb();
  const now = nowIso();
  await readStates.updateOne({ conversationId, email: normEmail(email) }, { $max: { readSeq: n }, $set: { updatedAt: now }, $setOnInsert: { conversationId, email: normEmail(email), orgId: conv.orgId } }, { upsert: true });
  await participants.updateOne({ _id: participant._id }, { $set: { lastFocusAt: now } });
  const rs = await readStates.findOne({ conversationId, email: normEmail(email) });
  return { readSeq: rs.readSeq };
}

/** Read receipts for the people in a conversation: only seq numbers, never content. */
export async function readReceipts({ orgId, email, conversationId }) {
  await assertAccess({ orgId, email, conversationId, statuses: ["active"] });
  const { readStates } = await chatDb();
  const rows = await readStates.find({ conversationId }).toArray();
  return rows.map((r) => ({ email: r.email, readSeq: r.readSeq }));
}

// ---------------------------------------------------------------------------------------------------- welcomes + sync

export async function takeWelcomes({ orgId, email, deviceId, peek = false }) {
  const dev = await getActiveDevice({ orgId, email, deviceId });
  if (!dev) fail(403, "Unknown or revoked device.", "DEVICE_REVOKED");
  const { envelopes } = await chatDb();
  const rows = await envelopes.find({ recipientDeviceId: deviceId, consumedAt: null }).sort({ createdAt: 1 }).limit(100).toArray();
  return rows.map((r) => ({ conversationId: r.conversationId, epoch: r.epoch, seq: r.seq, welcome: r.welcome }));
}

export async function ackWelcome({ orgId, email, deviceId, conversationId, epoch }) {
  const dev = await getActiveDevice({ orgId, email, deviceId });
  if (!dev) fail(403, "Unknown or revoked device.", "DEVICE_REVOKED");
  const { envelopes } = await chatDb();
  await envelopes.updateOne({ recipientDeviceId: deviceId, conversationId, epoch }, { $set: { consumedAt: nowIso() } });
  return { ok: true };
}

/** Full detail for ONE conversation: view, the plan this device may need to execute, and the roster (every participant row
 *  with its active device ids) that clients use to authorize incoming commits. Fetched only when a conversation changed. */
export async function conversationDetail({ orgId, email, deviceId, conversationId }) {
  const { conv, participant } = await assertAccess({ orgId, email, conversationId, statuses: ["active", "pending", "left", "removed"] });
  if (conv.status !== "active") fail(404, "Conversation not found.");
  const { participants, devices } = await chatDb();
  const dev = await getActiveDevice({ orgId, email, deviceId });
  if (!dev) fail(403, "Unknown or revoked device.", "DEVICE_REVOKED");
  const all = await participants.find({ conversationId }).toArray();
  const devs = await devices.find({ email: { $in: all.map((p) => p.email) }, status: "active" }).toArray();
  const byEmail = new Map(); for (const d of devs) { if (!byEmail.has(d.email)) byEmail.set(d.email, []); byEmail.get(d.email).push(d); }
  const view = participant.status === "left" || participant.status === "removed" ? null : await viewConversation({ conv, participant });
  const inGroup = conv.leaves.includes(deviceId);
  const plan = participant.status === "active" && inGroup ? await conversationPlan(conv) : { adds: [], removes: [], noDevices: [], epoch: conv.epoch };
  return {
    id: conv._id, kind: conv.kind, epoch: conv.epoch, lastSeq: conv.lastSeq, updatedAt: conv.updatedAt, inGroup, myStatus: participant.status,
    view, plan,
    roster: all.map((p) => ({ email: p.email, role: p.role, status: p.status, external: !!p.external, deviceIds: (byEmail.get(p.email) || []).map((d) => d.deviceId), fingerprints: (byEmail.get(p.email) || []).map((d) => ({ deviceId: d.deviceId, fingerprint: d.fingerprint })) })),
  };
}

/** Lightweight catch-up: one row per conversation (cursor, seq, epoch, unread, updatedAt) plus pending Welcomes. Safe to poll. */
export async function syncState({ orgId, email, deviceId, cursors = {} }) {
  const em = normEmail(email);
  const dev = await getActiveDevice({ orgId, email: em, deviceId });
  if (!dev) fail(403, "Unknown or revoked device.", "DEVICE_REVOKED");
  const { participants, conversations, readStates, messages } = await chatDb();
  const mine = await participants.find({ email: em, status: { $in: ["active", "pending", "left", "removed"] }, hidden: { $ne: true } }).sort({ conversationId: 1 }).limit(300).toArray();
  const convs = await conversations.find({ _id: { $in: mine.map((p) => p.conversationId) }, status: "active" }).toArray();
  const byId = new Map(convs.map((c) => [c._id, c]));
  const reads = await readStates.find({ email: em, conversationId: { $in: [...byId.keys()] } }).toArray();
  const readBy = new Map(reads.map((r) => [r.conversationId, r.readSeq]));
  const rows = [];
  for (const p of mine) {
    const conv = byId.get(p.conversationId); if (!conv) continue;
    if (conv.orgId !== String(orgId) && !p.external) continue;
    rows.push({ p, conv });
  }
  const out = await Promise.all(rows.map(async ({ p, conv }) => {
    const base = { id: conv._id, kind: conv.kind, status: p.status, role: p.role, epoch: conv.epoch, updatedAt: conv.updatedAt, muted: !!p.muted, archived: !!p.archived, cursor: cursors[conv._id] ?? 0, inGroup: conv.leaves.includes(deviceId) };
    if (p.status === "left" || p.status === "removed") return { ...base, lastSeq: Math.min(conv.lastSeq, p.removedAtSeq ?? conv.lastSeq), unread: 0 };
    const readSeq = Math.max(readBy.get(conv._id) || 0, p.joinSeq || 0);
    const unread = p.status === "pending" ? 0 : await messages.countDocuments({ conversationId: conv._id, seq: { $gt: readSeq }, kind: "app", sub: "msg", senderEmail: { $ne: em }, purged: { $ne: true } });
    return { ...base, lastSeq: conv.lastSeq, unread, lastMessageAt: conv.lastMessageAt || null, joinSeq: p.joinSeq || 0 };
  }));
  const welcomes = await takeWelcomes({ orgId, email: em, deviceId });
  await touchDevice(deviceId);
  return { conversations: out, welcomes, serverTime: nowIso() };
}

// ---------------------------------------------------------------------------------------------------- notifications

const SAFE_BODY = "Open Secure Chat to read it.";

async function notifyChat({ conv, toEmail, type, title, dedupe }) {
  try {
    await createNotification({ scope: "org", orgId: conv.orgId, targetEmail: toEmail, category: "business", type, title, body: SAFE_BODY, sourceModule: "chat", sourceId: conv._id, actionUrl: "/business?view=chat", metadata: {}, dedupeKey: dedupe });
  } catch { /* notifications never block chat */ }
}

/** One generic notification per conversation per recipient until they read it (no text, no names). */
async function notifyNewMessage({ conv, fromEmail, seq }) {
  try {
    const { participants, readStates, deliveries } = await chatDb();
    const people = await participants.find({ conversationId: conv._id, status: "active", email: { $ne: fromEmail }, muted: { $ne: true } }).limit(LIMITS.maxParticipants).toArray();
    const reads = await readStates.find({ conversationId: conv._id, email: { $in: people.map((p) => p.email) } }).toArray();
    const readBy = new Map(reads.map((r) => [r.email, r.readSeq]));
    for (const p of people) {
      const marker = readBy.get(p.email) || 0;
      await deliveries.insertOne({ orgId: conv.orgId, email: p.email, conversationId: conv._id, seq, channel: "in-app", createdAt: new Date() });
      await notifyChat({ conv, toEmail: p.email, type: "chat.message", title: "New secure message", dedupe: `chat:msg:${conv._id}:${p.email}:${marker}` });
    }
  } catch { /* best effort */ }
}
