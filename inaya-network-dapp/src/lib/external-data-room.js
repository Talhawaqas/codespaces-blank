// src/lib/external-data-room.js
//
// Financial Services & Regulated Enterprise SOW, Phase 9 (§19, §102,
// §229-230) — External Data Rooms: investor rooms, diligence rooms, and
// audit rooms. Regulatory examination rooms are NOT built here -- they
// already exist, shipped and tested, as regulatory-examination.js +
// regulatory-examination-access.js (Phase 4). This file deliberately
// GENERALIZES that same proven external-identity pattern (hash tokens
// before storage, TTL-indexed expiry, revoke = clear revokedAt + delete
// active sessions, an explicit per-session scope that never implies
// broader access) into ONE reusable engine for the three room types this
// phase actually needs, rather than forking three more near-identical
// files or risking a change to the already-shipped examination code.
//
// §230's guardrails are enforced structurally, not by instruction:
//   - no cross-room retrieval: every read function takes the session and
//     filters by session.roomId -- there is no function that can list
//     documents across rooms.
//   - no cross-tenant retrieval: every query is also filtered by
//     session.orgId.
//   - never answer from deleted/expired content: getRoomSession() checks
//     revokedAt, expiry, AND the room's own closedAt -- a closed room's
//     sessions stop resolving even before their token TTL elapses.
//   - access logging (§229): every real access is appended to
//     dataRoomAccessLog, never batched/best-effort-dropped.

import { getOrgCollections, toObjectId, hashToken, generateToken } from "./orgs.js";
import { canManageOrg, canManageFinancialEntities, canManageAudit } from "./orgGates.js";
import { logOrgActivity } from "./org-activity-log.js";

export const ROOM_TYPES = ["investor", "diligence", "audit"];
const EXTERNAL_MAGIC_LINK_TTL_MS = 30 * 60 * 1000; // 30 minutes, same as every other magic link in this app
const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function canManageRoomType(roomType, membership) {
  if (roomType === "audit") return canManageAudit(membership);
  if (roomType === "investor" || roomType === "diligence") return canManageFinancialEntities(membership);
  return canManageOrg(membership);
}

export async function createDataRoom({ orgId, roomType, name, relatedRecordId, actorEmail, membership }) {
  if (!ROOM_TYPES.includes(roomType)) return { error: `Unknown room type "${roomType}".`, status: 400 };
  if (!canManageRoomType(roomType, membership)) return { error: "You don't have permission to create this type of room.", status: 403 };
  if (!name?.trim()) return { error: "A room name is required.", status: 400 };

  const { dataRooms } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), roomType, name: name.trim(),
    relatedRecordId: relatedRecordId ? toObjectId(relatedRecordId) : null,
    documentIds: [], closedAt: null,
    createdByEmail: actorEmail, createdAt: now,
  };
  const result = await dataRooms.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };

  await logOrgActivity({ orgId, recordType: "DATA_ROOM", recordId: inserted._id, actorEmail, action: "CREATED", previousState: null, newState: null, metadata: { roomType, name: doc.name } });
  return { room: inserted };
}

export async function closeDataRoom({ orgId, roomId, actorEmail, membership }) {
  const { dataRooms } = await getOrgCollections();
  const room = await dataRooms.findOne({ _id: toObjectId(roomId), orgId: toObjectId(orgId) });
  if (!room) return { error: "Room not found.", status: 404 };
  if (!canManageRoomType(room.roomType, membership)) return { error: "You don't have permission to close this room.", status: 403 };

  const updated = await dataRooms.findOneAndUpdate(
    { _id: room._id, closedAt: null },
    { $set: { closedAt: new Date().toISOString() } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "This room is already closed.", status: 409 };

  await logOrgActivity({ orgId, recordType: "DATA_ROOM", recordId: room._id, actorEmail, action: "CLOSED", previousState: null, newState: null, metadata: {} });
  return { room: updated };
}

/** The curated allowlist -- a room exposes exactly these document IDs,
 *  never an implicit "everything in the org" or "everything matching a
 *  query" grant. */
export async function addDocumentToRoom({ orgId, roomId, documentId, actorEmail, membership }) {
  const { dataRooms, orgDocuments } = await getOrgCollections();
  const room = await dataRooms.findOne({ _id: toObjectId(roomId), orgId: toObjectId(orgId) });
  if (!room) return { error: "Room not found.", status: 404 };
  if (!canManageRoomType(room.roomType, membership)) return { error: "You don't have permission to manage this room's documents.", status: 403 };
  if (room.closedAt) return { error: "This room is closed.", status: 409 };

  const document = await orgDocuments.findOne({ _id: toObjectId(documentId), orgId: toObjectId(orgId) });
  if (!document) return { error: "Document not found in this org.", status: 404 };

  const updated = await dataRooms.findOneAndUpdate(
    { _id: room._id, documentIds: { $ne: document._id } },
    { $push: { documentIds: document._id } },
    { returnDocument: "after" }
  );
  const finalRoom = updated || room; // idempotent no-op if already added
  await logOrgActivity({ orgId, recordType: "DATA_ROOM", recordId: room._id, actorEmail, action: "DOCUMENT_ADDED", previousState: null, newState: null, metadata: { documentId: document._id.toString() } });
  return { room: finalRoom };
}

export async function removeDocumentFromRoom({ orgId, roomId, documentId, actorEmail, membership }) {
  const { dataRooms } = await getOrgCollections();
  const room = await dataRooms.findOne({ _id: toObjectId(roomId), orgId: toObjectId(orgId) });
  if (!room) return { error: "Room not found.", status: 404 };
  if (!canManageRoomType(room.roomType, membership)) return { error: "You don't have permission to manage this room's documents.", status: 403 };

  const updated = await dataRooms.findOneAndUpdate(
    { _id: room._id },
    { $pull: { documentIds: toObjectId(documentId) } },
    { returnDocument: "after" }
  );
  await logOrgActivity({ orgId, recordType: "DATA_ROOM", recordId: room._id, actorEmail, action: "DOCUMENT_REMOVED", previousState: null, newState: null, metadata: { documentId } });
  return { room: updated };
}

/** Issues a scoped magic link for a named external user. Never automatic,
 *  never self-service -- only whoever manages this room type can invite
 *  someone into it. */
export async function inviteExternalUser({ orgId, roomId, externalEmail, expiresInHours = 72, actorEmail, membership }) {
  if (!externalEmail?.trim()) return { error: "An external user email is required.", status: 400 };
  const { dataRooms, dataRoomExternalMagicLinks } = await getOrgCollections();
  const room = await dataRooms.findOne({ _id: toObjectId(roomId), orgId: toObjectId(orgId) });
  if (!room) return { error: "Room not found.", status: 404 };
  if (!canManageRoomType(room.roomType, membership)) return { error: "You don't have permission to invite users into this room.", status: 403 };
  if (room.closedAt) return { error: "This room is closed.", status: 409 };

  const token = generateToken();
  const now = new Date().toISOString();
  const doc = {
    tokenHash: hashToken(token),
    orgId: toObjectId(orgId), roomId: room._id,
    externalEmail: externalEmail.trim(),
    expiresAt: new Date(Date.now() + EXTERNAL_MAGIC_LINK_TTL_MS).toISOString(),
    usedAt: null,
    issuedByEmail: actorEmail,
    createdAt: now,
    sessionTtlMs: expiresInHours * 60 * 60 * 1000,
  };
  await dataRoomExternalMagicLinks.insertOne(doc);

  await logOrgActivity({ orgId, recordType: "DATA_ROOM", recordId: room._id, actorEmail, action: "EXTERNAL_ACCESS_ISSUED", previousState: null, newState: null, metadata: { externalEmail: doc.externalEmail } });
  return { token };
}

export async function exchangeRoomMagicLink(rawToken) {
  if (!rawToken) return { error: "missing_token", status: 400 };
  const { dataRoomExternalMagicLinks, dataRoomExternalSessions, dataRooms } = await getOrgCollections();

  const link = await dataRoomExternalMagicLinks.findOne({ tokenHash: hashToken(rawToken) });
  if (!link || link.usedAt || new Date(link.expiresAt).getTime() < Date.now()) {
    return { error: "invalid_or_expired", status: 400 };
  }
  const room = await dataRooms.findOne({ _id: link.roomId });
  if (!room || room.closedAt) return { error: "invalid_or_expired", status: 400 };

  const now = new Date().toISOString();
  await dataRoomExternalMagicLinks.updateOne({ _id: link._id }, { $set: { usedAt: now } });

  const sessionToken = generateToken();
  await dataRoomExternalSessions.insertOne({
    tokenHash: hashToken(sessionToken),
    orgId: link.orgId, roomId: link.roomId,
    externalEmail: link.externalEmail,
    revokedAt: null,
    expiresAt: new Date(Date.now() + (link.sessionTtlMs || DEFAULT_SESSION_TTL_MS)).toISOString(),
    createdAt: now,
  });

  return { sessionToken, orgId: link.orgId.toString(), roomId: link.roomId.toString() };
}

/** Resolves a raw session token, or null. Checks revokedAt, session
 *  expiry, AND the room's own closedAt -- a closed room stops resolving
 *  sessions immediately, not just once each token's own TTL elapses. */
export async function getRoomSession(rawToken) {
  if (!rawToken) return null;
  const { dataRoomExternalSessions, dataRooms } = await getOrgCollections();
  const session = await dataRoomExternalSessions.findOne({ tokenHash: hashToken(rawToken) });
  if (!session) return null;
  if (session.revokedAt) return null;
  if (new Date(session.expiresAt).getTime() < Date.now()) return null;
  const room = await dataRooms.findOne({ _id: session.roomId });
  if (!room || room.closedAt) return null;
  return session;
}

export async function revokeRoomAccess({ orgId, roomId, externalEmail, actorEmail, membership }) {
  const { dataRooms, dataRoomExternalSessions } = await getOrgCollections();
  const room = await dataRooms.findOne({ _id: toObjectId(roomId), orgId: toObjectId(orgId) });
  if (!room) return { error: "Room not found.", status: 404 };
  if (!canManageRoomType(room.roomType, membership)) return { error: "You don't have permission to revoke access to this room.", status: 403 };

  const query = { orgId: toObjectId(orgId), roomId: toObjectId(roomId), externalEmail };
  const now = new Date().toISOString();
  await dataRoomExternalSessions.updateMany(query, { $set: { revokedAt: now } });
  await dataRoomExternalSessions.deleteMany(query);

  await logOrgActivity({ orgId, recordType: "DATA_ROOM", recordId: room._id, actorEmail, action: "EXTERNAL_ACCESS_REVOKED", previousState: null, newState: null, metadata: { externalEmail } });
  return { revoked: true };
}

/** The only read path an external session ever uses -- scoped by
 *  session.orgId AND session.roomId, so cross-room and cross-tenant
 *  retrieval are both structurally impossible here, not just policy. */
export async function listRoomDocuments(session) {
  const { dataRooms, orgDocuments } = await getOrgCollections();
  const room = await dataRooms.findOne({ _id: session.roomId, orgId: session.orgId });
  if (!room || room.closedAt) return { documents: [] };
  const documents = await orgDocuments.find({ _id: { $in: room.documentIds }, orgId: session.orgId }).toArray();
  await recordRoomAccess({ session, action: "LIST_DOCUMENTS" });
  return { documents };
}

/** §229's access logging -- a real, non-best-effort append, since this is
 *  the accountability record for what an external party actually saw. */
export async function recordRoomAccess({ session, action, documentId }) {
  const { dataRoomAccessLog } = await getOrgCollections();
  await dataRoomAccessLog.insertOne({
    orgId: session.orgId, roomId: session.roomId, externalEmail: session.externalEmail,
    action, documentId: documentId ? toObjectId(documentId) : null,
    accessedAt: new Date().toISOString(),
  });
}

export async function getRoomAccessLog(orgId, roomId) {
  const { dataRoomAccessLog } = await getOrgCollections();
  return dataRoomAccessLog.find({ orgId: toObjectId(orgId), roomId: toObjectId(roomId) }).sort({ accessedAt: -1 }).toArray();
}

export async function listDataRooms(orgId, { roomType } = {}) {
  const { dataRooms } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId) };
  if (roomType) query.roomType = roomType;
  return dataRooms.find(query).sort({ createdAt: -1 }).toArray();
}

export async function getDataRoom(orgId, roomId) {
  const { dataRooms } = await getOrgCollections();
  return dataRooms.findOne({ _id: toObjectId(roomId), orgId: toObjectId(orgId) });
}
