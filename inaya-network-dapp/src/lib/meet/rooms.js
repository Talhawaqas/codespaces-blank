// src/lib/meet/rooms.js
//
// Inaya Meet room lifecycle (Internxt-inspired SOW, Workstream C). See docs/architecture/
// meet-architecture-adr.md for the full protocol this implements: peer-to-peer mesh media,
// signaling over the same long-poll/SSE pattern Secure Chat already uses (src/lib/meet/signaling.js),
// and a room secret generated locally on the host's device and wrapped per admitted participant
// through the existing algorithm-agile sharing primitive (custody-sdk's Pqc.wrapForRecipient,
// PQC-A05) -- never a new envelope format. This module never sees the room secret, a device's
// private key, or any media/chat plaintext; it only stores and relays opaque wrapped envelopes and
// non-secret lifecycle state.
//
// Moderator authorization is resolved from the database on every call, never from a client-asserted
// role (SOW §7.12's explicit requirement) -- requireHost()/requireModerator() below are the only
// place "can this caller moderate this room" is decided.

import { ObjectId } from "mongodb";
import { Pqc } from "@inaya-network/custody-sdk";
import { canManageOrg } from "../orgs.js";
import { hasAdminRole } from "../orgGates.js";
import { slidingWindowCheck } from "../rateLimit.js";
import { logOrgActivity } from "../org-activity-log.js";
import { createConversation, addParticipants } from "../chat/conversations.js";
import { chatDb } from "../chat/common.js";
import { LIMITS, GUEST_ACCESS_MODES, POLICY_KEY_MODES, fail, nowIso, normEmail, newToken, hashToken, isPqcEnvelope, meetDb, toObjectId } from "./common.js";
import { broadcastControl } from "./signaling.js";

const oid = (id) => { try { return new ObjectId(id); } catch { fail(404, "Meeting not found."); } };
const notify = (args) => import("../notify/router.js").then((m) => m.notifyEvent(args)).catch(() => {});

function defaultPolicy(patch = {}) {
  return {
    // Defaults to CLASSICAL, not HYBRID_PQC: this release ships the server-side envelope relay and
    // enforcement in full (see approveParticipant below), but no UI in this codebase yet resolves a
    // recipient's device public key client-side to actually produce a wrapped envelope -- that
    // integration is a real, separate piece of work (see docs/internxt-implementation-ledger.md,
    // Workstream C). HYBRID_PQC/PQC_REQUIRED remain selectable and are correctly enforced the moment
    // that client wiring lands; defaulting new rooms to a mode nothing can yet satisfy would make
    // "Meet" unusable out of the box. A CLASSICAL-mode meeting is not unencrypted: WebRTC's own
    // DTLS-SRTP still encrypts all media in transit (see the Meet ADR §4) -- this setting is about
    // the additional application-level key-establishment layer, not the baseline media encryption.
    keyMode: POLICY_KEY_MODES.LEGACY_CLASSICAL,
    guestAccess: "approval",
    namedGuestEmails: [],
    maxParticipants: LIMITS.maxParticipantsDefault,
    orgMemberAutoAdmit: true,
    chatEnabled: true,
    screenShareEnabled: true,
    ...patch,
  };
}

function validatePolicy(input, { partial = false } = {}) {
  const v = {}; const has = (k) => !partial || input[k] !== undefined;
  if (has("keyMode")) { if (!Object.values(POLICY_KEY_MODES).includes(input.keyMode)) fail(400, `keyMode must be one of: ${Object.values(POLICY_KEY_MODES).join(", ")}.`); v.keyMode = input.keyMode; }
  if (has("guestAccess")) { if (!GUEST_ACCESS_MODES.includes(input.guestAccess)) fail(400, `guestAccess must be one of: ${GUEST_ACCESS_MODES.join(", ")}.`); v.guestAccess = input.guestAccess; }
  if (has("namedGuestEmails")) {
    const list = Array.isArray(input.namedGuestEmails) ? input.namedGuestEmails : [];
    if (list.length > LIMITS.namedGuestEmailsMax) fail(400, `At most ${LIMITS.namedGuestEmailsMax} named guest addresses.`);
    v.namedGuestEmails = [...new Set(list.map(normEmail).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)))];
  }
  if (has("maxParticipants")) {
    const n = Number(input.maxParticipants);
    if (!Number.isInteger(n) || n < 2 || n > LIMITS.maxParticipantsCap) fail(400, `maxParticipants must be 2 to ${LIMITS.maxParticipantsCap} (mesh media does not scale past that -- see the Meet ADR).`);
    v.maxParticipants = n;
  }
  if (has("orgMemberAutoAdmit")) v.orgMemberAutoAdmit = !!input.orgMemberAutoAdmit;
  if (has("chatEnabled")) v.chatEnabled = !!input.chatEnabled;
  if (has("screenShareEnabled")) v.screenShareEnabled = !!input.screenShareEnabled;
  return v;
}

const roomView = (r) => ({
  roomId: String(r._id), orgId: r.orgId, hostEmail: r.hostEmail, title: r.title, kind: r.kind, status: r.status,
  policy: r.policy, scheduledStart: r.scheduledStart || null, scheduledEnd: r.scheduledEnd || null,
  conversationId: r.conversationId || null, algorithmId: r.algorithmId || null,
  createdAt: r.createdAt, startedAt: r.startedAt || null, endedAt: r.endedAt || null, lockedAt: r.lockedAt || null,
  // The plaintext join token is returned ONLY by createRoom (right after insert) and never again --
  // every other read of a room returns null here, matching "never contain raw meeting encryption
  // keys" discipline (§7.10) extended to the join link itself.
});

const participantView = (p) => ({
  participantId: String(p._id), roomId: String(p.roomId), email: p.email || null, isGuest: !!p.isGuest,
  guestName: p.guestName || null, deviceId: p.deviceId || null, role: p.role, status: p.status,
  algorithmId: p.algorithmId || null, requestedAt: p.requestedAt, admittedAt: p.admittedAt || null,
  leftAt: p.leftAt || null, removedAt: p.removedAt || null,
});

async function loadRoom({ orgId, roomId }) {
  const { rooms } = await meetDb();
  const r = await rooms.findOne({ _id: oid(roomId), orgId: String(orgId) });
  if (!r) fail(404, "Meeting not found.");
  return r;
}

/** Resolves the caller's existing participant row in this room, or null. Never creates one. */
async function myParticipant({ roomId, email, participantId, guestToken }) {
  const { participants } = await meetDb();
  if (email) return participants.findOne({ roomId: oid(roomId), email: normEmail(email), status: { $in: ["waiting", "admitted"] } }, { sort: { requestedAt: -1 } });
  if (participantId && guestToken) {
    const p = await participants.findOne({ _id: oid(participantId), roomId: oid(roomId), status: { $in: ["waiting", "admitted"] } });
    return p && p.guestTokenHash === hashToken(guestToken) ? p : null;
  }
  return null;
}

function requireHostOrModerator(room, membership, actorEmail) {
  if (normEmail(actorEmail) === normEmail(room.hostEmail)) return;
  if (canManageOrg(membership)) return;
  fail(403, "Only the meeting host or an organization admin can do that.");
}

// ------------------------------------------------------------------------------------------------ creation

export async function createRoom({ orgId, membership, hostEmail, deviceId, title, kind = "instant", scheduledStart = null, scheduledEnd = null, policy = {}, inviteEmails = [] }) {
  const host = normEmail(hostEmail);
  if (!["instant", "scheduled"].includes(kind)) fail(400, "kind must be instant or scheduled.");
  const t = String(title || "").trim().slice(0, LIMITS.maxTitleLen) || (kind === "instant" ? "Meeting" : "Scheduled meeting");
  if (kind === "scheduled") {
    if (!scheduledStart || isNaN(new Date(scheduledStart))) fail(400, "scheduledStart must be a valid date for a scheduled meeting.");
    if (scheduledEnd && isNaN(new Date(scheduledEnd))) fail(400, "scheduledEnd must be a valid date.");
    if (new Date(scheduledStart).getTime() > Date.now() + LIMITS.scheduleWindowDays * 86400_000) fail(400, `Meetings can only be scheduled up to ${LIMITS.scheduleWindowDays} days ahead.`);
  }
  const rl = await slidingWindowCheck({ action: "meet:create", key: `${orgId}:${host}`, max: LIMITS.roomsPerOrgHour, windowMs: 3600_000 });
  if (!rl.allowed) fail(429, "You are creating meetings too quickly.", "RATE_LIMITED");

  const { rooms, participants } = await meetDb();
  const _id = new ObjectId();
  const joinToken = newToken(LIMITS.joinTokenBytes);
  const now = nowIso();

  // Meeting chat (§7.16): reuses the existing conversation model with the "meeting" kind, starting
  // with the host only. Best-effort -- a host who isn't chat-enrolled yet still gets a working
  // meeting room, just without in-call chat, rather than Meet being blocked on chat's own
  // device-enrollment precondition.
  let conversationId = null;
  try {
    const conv = await createConversation({ orgId, membership, email: host, deviceId, conversationId: new ObjectId().toHexString(), kind: "meeting", emails: [] });
    conversationId = conv.conversation.id;
  } catch { /* chat unavailable for this host right now; the meeting itself still works */ }

  const doc = {
    _id, orgId: String(orgId), hostEmail: host, title: t, kind, status: kind === "scheduled" ? "scheduled" : "lobby",
    policy: defaultPolicy(policy ? validatePolicy(policy, { partial: true }) : {}), scheduledStart, scheduledEnd, conversationId,
    joinTokenHash: hashToken(joinToken), algorithmId: null,
    createdAt: now, startedAt: kind === "instant" ? now : null, endedAt: null, lockedAt: null, updatedAt: now,
  };
  await rooms.insertOne(doc);
  // The host is always participant #1, auto-admitted (no envelope needed yet -- the host derives
  // the room secret itself; nothing to wrap to the creator of the secret).
  await participants.insertOne({ _id: new ObjectId(), roomId: _id, orgId: String(orgId), email: host, isGuest: false, deviceId: deviceId || null, role: "host", status: "admitted", requestedAt: now, admittedAt: now, admittedBy: host });
  await logOrgActivity({ orgId, recordType: "MEETING", recordId: _id, actorEmail: host, action: "MEETING_CREATED", previousState: null, newState: null, metadata: { kind, policy: doc.policy } });

  const invitees = [...new Set((inviteEmails || []).map(normEmail).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) && e !== host))].slice(0, LIMITS.namedGuestEmailsMax);
  for (const email of invitees) {
    notify({ orgId, event: "meeting.invitation", targetEmail: email, title: `You're invited: ${t}`, body: kind === "scheduled" ? `${host} scheduled "${t}" for ${scheduledStart}.` : `${host} started a meeting: "${t}".`, link: `/meet/${joinToken}`, sourceId: String(_id), dedupeKey: `meet:invite:${_id}:${email}` });
  }

  return { ...roomView(doc), joinToken, joinLink: `/meet/${joinToken}` };
}

// -------------------------------------------------------------------------------------------------- access/read

/** Resolves a bare join token to the minimal public info the /meet/[token] landing page needs
 *  before anyone has authenticated or joined: which room, its org, title and whether guests are
 *  even allowed -- never the join token itself (already consumed to get here) and never anything
 *  about who else is in the room. orgId is NOT an input: joinTokenHash is unique across the whole
 *  collection by construction (see the unique index in meet/common.js), so the token alone is
 *  enough to find the room without the caller needing to already know which org it belongs to. */
export async function getRoomByToken({ joinToken }) {
  const { rooms } = await meetDb();
  const r = await rooms.findOne({ joinTokenHash: hashToken(String(joinToken || "")) });
  if (!r) fail(404, "This meeting link is not valid.");
  if (r.status === "ended") fail(410, "This meeting has ended.", "MEETING_ENDED");
  return { roomId: String(r._id), orgId: r.orgId, title: r.title, status: r.status, guestAccess: r.policy.guestAccess };
}

export async function getRoom({ orgId, membership, email, roomId, participantId, guestToken }) {
  const r = await loadRoom({ orgId, roomId });
  const mine = await myParticipant({ roomId, email, participantId, guestToken });
  if (!mine && normEmail(email) !== normEmail(r.hostEmail) && !(membership && canManageOrg(membership))) fail(404, "Meeting not found.");
  return { ...roomView(r), me: mine ? participantView(mine) : null };
}

export async function listRooms({ orgId, membership, email, scope = "mine", limit = 50 }) {
  const { rooms, participants } = await meetDb();
  if (scope === "org" && canManageOrg(membership)) {
    const rows = await rooms.find({ orgId: String(orgId) }).sort({ createdAt: -1 }).limit(Math.min(limit, 200)).toArray();
    return { rooms: rows.map(roomView), scope: "org" };
  }
  const mine = await participants.find({ orgId: String(orgId), email: normEmail(email), status: { $in: ["waiting", "admitted"] } }).project({ roomId: 1 }).toArray();
  const ids = [...new Set(mine.map((p) => String(p.roomId)))].map((id) => new ObjectId(id));
  const rows = ids.length ? await rooms.find({ _id: { $in: ids } }).sort({ createdAt: -1 }).limit(Math.min(limit, 200)).toArray() : [];
  return { rooms: rows.map(roomView), scope: "mine" };
}

export async function updatePolicy({ orgId, membership, actorEmail, roomId, patch }) {
  const r = await loadRoom({ orgId, roomId });
  requireHostOrModerator(r, membership, actorEmail);
  if (r.status === "ended") fail(409, "That meeting has already ended.");
  const set = validatePolicy(patch, { partial: true });
  if (!Object.keys(set).length) return { ...roomView(r) };
  const { rooms } = await meetDb();
  await rooms.updateOne({ _id: r._id }, { $set: { policy: { ...r.policy, ...set }, updatedAt: nowIso() } });
  await logOrgActivity({ orgId, recordType: "MEETING", recordId: r._id, actorEmail, action: "MEETING_POLICY_UPDATED", previousState: null, newState: null, metadata: { fields: Object.keys(set) } });
  return getRoom({ orgId, membership, email: actorEmail, roomId });
}

// ------------------------------------------------------------------------------------------------------- join

/**
 * Either an org member (authenticated session, `email` set) or a guest (`email` null, `guestName` set) requesting
 * to enter a room via its join token. Server-enforced: the client NEVER gets to assert "I'm the host" or
 * "admit me automatically" -- every admission rule below is decided from room.policy and room.hostEmail alone.
 */
export async function requestJoin({ orgId, roomId, joinToken, email, deviceId, guestName }) {
  const r = await loadRoom({ orgId, roomId });
  if (hashToken(String(joinToken || "")) !== r.joinTokenHash) fail(404, "Meeting not found.");
  if (r.status === "ended") fail(410, "This meeting has ended.", "MEETING_ENDED");
  if (r.status === "locked") {
    const existing = await myParticipant({ roomId, email });
    if (!existing) fail(403, "This meeting is locked.", "ROOM_LOCKED");
  }

  const rl = await slidingWindowCheck({ action: "meet:join", key: `${roomId}:${email || "guest"}`, max: LIMITS.joinAttemptsPerMinute, windowMs: 60_000 });
  if (!rl.allowed) fail(429, "Too many join attempts. Wait a moment and try again.", "RATE_LIMITED");

  const { rooms, participants } = await meetDb();
  const now = nowIso();

  // Returning participant (already admitted or still waiting) -- idempotent rejoin, not a new row.
  const already = await participants.findOne({ roomId: r._id, email: email ? normEmail(email) : null, status: { $in: ["waiting", "admitted"] } });
  if (already) return { ...participantView(already), waiting: already.status === "waiting" };

  const isGuest = !email;
  if (isGuest) {
    if (r.policy.guestAccess === "forbidden") fail(403, "This meeting does not allow guests.", "GUEST_FORBIDDEN");
    const name = String(guestName || "").trim().slice(0, LIMITS.guestNameLen);
    if (!name) fail(400, "A display name is required to join as a guest.");
  }

  const count = await participants.countDocuments({ roomId: r._id, status: "admitted" });
  if (count >= r.policy.maxParticipants) fail(409, `This meeting is full (${r.policy.maxParticipants} participants).`, "ROOM_FULL");

  let status = "waiting";
  let guestToken = null;
  const doc = {
    _id: new ObjectId(), roomId: r._id, orgId: String(orgId), email: isGuest ? null : normEmail(email),
    isGuest, guestName: isGuest ? String(guestName).trim().slice(0, LIMITS.guestNameLen) : null,
    deviceId: deviceId || null, role: "participant", status, requestedAt: now, admittedAt: null, admittedBy: null,
    guestTokenHash: null,
  };

  if (isGuest) {
    if (r.policy.guestAccess === "named") {
      fail(403, "This meeting is limited to invited guests. Ask the host for a direct invitation.", "GUEST_NOT_NAMED");
      // Named-guest identity verification (email + one-time code via the existing notification
      // primitive) is a real §7.22 requirement; this v1 ships the simpler, equally honest "approval"
      // and "allowed" modes end-to-end and documents named-guest OTP as a DEFERRED follow-on in the
      // ledger rather than half-implementing email verification here.
    }
    guestToken = newToken(LIMITS.guestTokenBytes);
    doc.guestTokenHash = hashToken(guestToken);
  }

  const autoAdmit = (!isGuest && r.policy.orgMemberAutoAdmit) || (isGuest && r.policy.guestAccess === "allowed");
  if (autoAdmit) { doc.status = "admitted"; doc.admittedAt = now; doc.admittedBy = "policy:auto"; status = "admitted"; }

  await participants.insertOne(doc);
  if (r.status === "lobby") await rooms.updateOne({ _id: r._id }, { $set: { status: "active", startedAt: r.startedAt || now, updatedAt: now } });

  if (!autoAdmit) notify({ orgId, event: "meeting.participant_waiting", targetEmail: r.hostEmail, title: "Someone is waiting to join your meeting", body: isGuest ? `${doc.guestName} (guest) is in the lobby for "${r.title}".` : `${doc.email} is in the lobby for "${r.title}".`, link: `/business?view=meet&roomId=${r._id}`, sourceId: String(doc._id), dedupeKey: `meet:waiting:${doc._id}` });
  else if (!isGuest && r.conversationId) await addParticipants({ orgId, membership: {}, email: r.hostEmail, conversationId: r.conversationId, emails: [doc.email] }).catch(() => {});

  await logOrgActivity({ orgId, recordType: "MEETING_PARTICIPANT", recordId: doc._id, actorEmail: isGuest ? null : doc.email, action: autoAdmit ? "PARTICIPANT_ADMITTED" : "PARTICIPANT_REQUESTED", previousState: null, newState: null, metadata: { roomId: String(r._id), isGuest } });

  return { ...participantView(doc), waiting: status === "waiting", guestToken };
}

export async function listWaiting({ orgId, membership, actorEmail, roomId }) {
  const r = await loadRoom({ orgId, roomId });
  requireHostOrModerator(r, membership, actorEmail);
  const { participants } = await meetDb();
  const rows = await participants.find({ roomId: r._id, status: "waiting" }).sort({ requestedAt: 1 }).toArray();
  return { waiting: rows.map(participantView) };
}

export async function listParticipants({ orgId, membership, email, roomId }) {
  const r = await loadRoom({ orgId, roomId });
  const mine = await myParticipant({ roomId, email });
  if (!mine && normEmail(email) !== normEmail(r.hostEmail) && !canManageOrg(membership)) fail(404, "Meeting not found.");
  const { participants } = await meetDb();
  const rows = await participants.find({ roomId: r._id, status: "admitted" }).sort({ admittedAt: 1 }).toArray();
  return { participants: rows.map(participantView) };
}

/**
 * The admitting client (host/moderator, present in the lobby UI) has already generated the room
 * secret (or fetched its own wrapped copy) and wraps it fresh to the admitted participant's device
 * using Pqc.wrapForRecipient under the room's policy.keyMode. This function only stores that opaque
 * envelope and never attempts to interpret, decrypt, or re-derive it.
 */
export async function approveParticipant({ orgId, membership, actorEmail, roomId, participantId, roomSecretEnvelope, algorithmId }) {
  const r = await loadRoom({ orgId, roomId });
  requireHostOrModerator(r, membership, actorEmail);
  if (r.status === "ended") fail(409, "That meeting has already ended.");
  const { participants, rooms } = await meetDb();
  const p = await participants.findOne({ _id: oid(participantId), roomId: r._id, status: "waiting" });
  if (!p) fail(404, "No waiting participant with that id.");

  // PQC_REQUIRED is the only mode where an envelope is mandatory and must actually be a hybrid
  // envelope (no silent downgrade, SOW §4.17). CLASSICAL and HYBRID_PQC accept an envelope when the
  // admitting client has one to offer, but don't require it -- the meeting's baseline media
  // encryption is WebRTC's own DTLS-SRTP regardless (see the Meet ADR §4); the envelope only carries
  // the additional application-level key layer when one is available.
  if (r.policy.keyMode === POLICY_KEY_MODES.PQC_REQUIRED && (!roomSecretEnvelope || !isPqcEnvelope(roomSecretEnvelope))) {
    fail(409, "This meeting requires hybrid PQC key establishment. That participant's device does not have a registered PQC key yet.", "PQC_REQUIRED_MISMATCH");
  }
  if (roomSecretEnvelope && JSON.stringify(roomSecretEnvelope).length > LIMITS.roomSecretEnvelopeBytes) fail(400, "roomSecretEnvelope is too large.");

  const now = nowIso();
  await participants.updateOne({ _id: p._id }, { $set: { status: "admitted", admittedAt: now, admittedBy: normEmail(actorEmail), roomSecretEnvelope, algorithmId: algorithmId || null } });
  if (!r.algorithmId && algorithmId) await rooms.updateOne({ _id: r._id }, { $set: { algorithmId } });
  if (!p.isGuest && r.conversationId) await addParticipants({ orgId, membership, email: actorEmail, conversationId: r.conversationId, emails: [p.email] }).catch(() => {});

  await logOrgActivity({ orgId, recordType: "MEETING_PARTICIPANT", recordId: p._id, actorEmail, action: "PARTICIPANT_ADMITTED", previousState: null, newState: null, metadata: { roomId: String(r._id), algorithmId: algorithmId || null } });
  if (!p.isGuest) notify({ orgId, event: "meeting.admitted", targetEmail: p.email, title: "You were admitted to the meeting", body: `You can now join "${r.title}".`, link: `/business?view=meet&roomId=${r._id}`, sourceId: String(p._id), dedupeKey: `meet:admitted:${p._id}` });
  return { ...participantView({ ...p, status: "admitted", admittedAt: now, algorithmId }) };
}

export async function rejectParticipant({ orgId, membership, actorEmail, roomId, participantId, reason }) {
  const r = await loadRoom({ orgId, roomId });
  requireHostOrModerator(r, membership, actorEmail);
  const { participants } = await meetDb();
  const p = await participants.findOne({ _id: oid(participantId), roomId: r._id, status: "waiting" });
  if (!p) fail(404, "No waiting participant with that id.");
  await participants.updateOne({ _id: p._id }, { $set: { status: "rejected" } });
  await logOrgActivity({ orgId, recordType: "MEETING_PARTICIPANT", recordId: p._id, actorEmail, action: "PARTICIPANT_REJECTED", previousState: null, newState: null, metadata: { roomId: String(r._id), reason: String(reason || "").slice(0, 200) || undefined } });
  return { ok: true };
}

/**
 * Removes an admitted participant. Mesh media has no server-side enforcement point (there is no
 * SFU): this flips the participant's status so signaling/join reject them going forward, and
 * src/lib/meet/signaling.js broadcasts a "participant-removed" control event so every other
 * admitted peer's client tears down its RTCPeerConnection to them. That peer-cooperation step is a
 * real, documented limitation of mesh topology (see the Meet ADR §3) -- not a server-side guarantee
 * the way a real SFU could provide.
 */
export async function removeParticipant({ orgId, membership, actorEmail, roomId, participantId, reason }) {
  const r = await loadRoom({ orgId, roomId });
  requireHostOrModerator(r, membership, actorEmail);
  const { participants } = await meetDb();
  const p = await participants.findOne({ _id: oid(participantId), roomId: r._id, status: "admitted" });
  if (!p) fail(404, "No admitted participant with that id.");
  if (normEmail(p.email) === normEmail(r.hostEmail)) fail(400, "The host cannot be removed. End the meeting instead.");
  await participants.updateOne({ _id: p._id }, { $set: { status: "removed", removedAt: nowIso(), removedBy: normEmail(actorEmail) } });
  await logOrgActivity({ orgId, recordType: "MEETING_PARTICIPANT", recordId: p._id, actorEmail, action: "PARTICIPANT_REMOVED", previousState: null, newState: null, metadata: { roomId: String(r._id), reason: String(reason || "").slice(0, 200) || undefined } });
  await broadcastControl({ roomId: r._id, orgId, action: "participant-removed", data: { participantId: String(p._id) } });
  return { ok: true };
}

/** Soft mute request (§7.12): mesh media has no central mixer to force a mute, so this only asks
 *  the participant's own client to mute itself -- "where supported by the media stack," per the SOW's
 *  own qualifier. */
export async function muteParticipant({ orgId, membership, actorEmail, roomId, participantId }) {
  const r = await loadRoom({ orgId, roomId });
  requireHostOrModerator(r, membership, actorEmail);
  const { participants } = await meetDb();
  const p = await participants.findOne({ _id: oid(participantId), roomId: r._id, status: "admitted" });
  if (!p) fail(404, "No admitted participant with that id.");
  await broadcastControl({ roomId: r._id, orgId, action: "mute-request", data: { participantId: String(p._id) } });
  await logOrgActivity({ orgId, recordType: "MEETING_PARTICIPANT", recordId: p._id, actorEmail, action: "PARTICIPANT_MUTE_REQUESTED", previousState: null, newState: null, metadata: { roomId: String(r._id) } });
  return { ok: true };
}

export async function leaveRoom({ orgId, roomId, participantId, email, guestToken }) {
  const r = await loadRoom({ orgId, roomId });
  const { participants } = await meetDb();
  const q = { _id: oid(participantId), roomId: r._id, status: "admitted" };
  if (email) q.email = normEmail(email); else if (guestToken) q.guestTokenHash = hashToken(guestToken); else fail(401, "Not authorized.");
  const p = await participants.findOne(q);
  if (!p) fail(404, "Not found.");
  await participants.updateOne({ _id: p._id }, { $set: { status: "left", leftAt: nowIso() } });
  await logOrgActivity({ orgId, recordType: "MEETING_PARTICIPANT", recordId: p._id, actorEmail: p.email, action: "PARTICIPANT_LEFT", previousState: null, newState: null, metadata: { roomId: String(r._id) } });
  return { ok: true };
}

export async function lockRoom({ orgId, membership, actorEmail, roomId, locked }) {
  const r = await loadRoom({ orgId, roomId });
  requireHostOrModerator(r, membership, actorEmail);
  if (r.status === "ended") fail(409, "That meeting has already ended.");
  const { rooms } = await meetDb();
  const status = locked ? "locked" : "active";
  await rooms.updateOne({ _id: r._id }, { $set: { status, lockedAt: locked ? nowIso() : null, updatedAt: nowIso() } });
  await logOrgActivity({ orgId, recordType: "MEETING", recordId: r._id, actorEmail, action: locked ? "MEETING_LOCKED" : "MEETING_UNLOCKED", previousState: null, newState: null, metadata: {} });
  await broadcastControl({ roomId: r._id, orgId, action: locked ? "room-locked" : "room-unlocked" });
  return { ok: true, status };
}

/** Ends the meeting for everyone. Per §7.17, the ephemeral meeting chat's ciphertext is deleted --
 *  the server never had plaintext to begin with (E2EE), so this only removes the stored ciphertext
 *  rows, never "recovers" anything a client might claim is retained. */
export async function endRoom({ orgId, membership, actorEmail, roomId }) {
  const r = await loadRoom({ orgId, roomId });
  requireHostOrModerator(r, membership, actorEmail);
  if (r.status === "ended") return { ok: true, alreadyEnded: true };
  const { rooms, participants } = await meetDb();
  const now = nowIso();
  await rooms.updateOne({ _id: r._id }, { $set: { status: "ended", endedAt: now, updatedAt: now } });
  await participants.updateMany({ roomId: r._id, status: "admitted" }, { $set: { status: "left", leftAt: now } });

  if (r.conversationId) {
    try {
      const { conversations, messages } = await chatDb();
      await messages.deleteMany({ conversationId: r.conversationId });
      await conversations.updateOne({ _id: r.conversationId }, { $set: { status: "closed", updatedAt: now } });
    } catch { /* best-effort cleanup; the room itself is already marked ended either way */ }
  }

  await logOrgActivity({ orgId, recordType: "MEETING", recordId: r._id, actorEmail, action: "MEETING_ENDED", previousState: null, newState: null, metadata: {} });
  await broadcastControl({ roomId: r._id, orgId, action: "meeting-ended" });
  return { ok: true };
}
