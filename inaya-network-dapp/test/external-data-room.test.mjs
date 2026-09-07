// test/external-data-room.test.mjs
//
// Financial Services & Regulated Enterprise SOW, Phase 9 (§19, §102,
// §229-230) — External Data Rooms. The load-bearing §230 guardrails:
// no cross-room retrieval, no cross-tenant retrieval, never serve from a
// closed/expired room, and every real access is logged.
//
// Run with: node --env-file=.env.local --test test/external-data-room.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import mongoClientPromise from "../src/lib/mongodb.js";
import {
  createDataRoom, closeDataRoom, addDocumentToRoom, removeDocumentFromRoom,
  inviteExternalUser, exchangeRoomMagicLink, getRoomSession, revokeRoomAccess,
  listRoomDocuments, getRoomAccessLog,
} from "../src/lib/external-data-room.js";

const RUN_ID = randomUUID().slice(0, 8);
const OWNER_EMAIL = `dataroom-${RUN_ID}@example.com`;
const MEMBERSHIP = { role: "owner", email: OWNER_EMAIL };
const EXTERNAL_EMAIL = `external-${RUN_ID}@example.com`;
let collections;
let orgId, otherOrgId, documentId, otherOrgDocumentId;

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
  const now = new Date().toISOString();
  const orgResult = await collections.orgs.insertOne({ name: `Data Room Test ${RUN_ID} Co`, ownerEmail: OWNER_EMAIL, vertical: "financial", createdAt: now });
  orgId = orgResult.insertedId;
  const otherOrgResult = await collections.orgs.insertOne({ name: `Data Room Test ${RUN_ID} Other Co`, ownerEmail: OWNER_EMAIL, vertical: "financial", createdAt: now });
  otherOrgId = otherOrgResult.insertedId;

  const docResult = await collections.orgDocuments.insertOne({ orgId, title: `Fund Deck ${RUN_ID}`, fileHash: `fake-hash-${RUN_ID}-a`, createdAt: now, deletedAt: null });
  documentId = docResult.insertedId;
  const otherDocResult = await collections.orgDocuments.insertOne({ orgId: otherOrgId, title: `Other Org Secret ${RUN_ID}`, fileHash: `fake-hash-${RUN_ID}-b`, createdAt: now, deletedAt: null });
  otherOrgDocumentId = otherDocResult.insertedId;
});

after(async () => {
  await Promise.all([
    collections.orgs.deleteMany({ _id: { $in: [orgId, otherOrgId] } }),
    collections.orgDocuments.deleteMany({ _id: { $in: [documentId, otherOrgDocumentId] } }),
    collections.dataRooms.deleteMany({ orgId: { $in: [orgId, otherOrgId] } }),
    collections.dataRoomExternalMagicLinks.deleteMany({ orgId: { $in: [orgId, otherOrgId] } }),
    collections.dataRoomExternalSessions.deleteMany({ orgId: { $in: [orgId, otherOrgId] } }),
    collections.dataRoomAccessLog.deleteMany({ orgId: { $in: [orgId, otherOrgId] } }),
    collections.orgActivity.deleteMany({ orgId: { $in: [orgId, otherOrgId] } }),
  ]);
  const client = await mongoClientPromise;
  await client.close();
});

test("full lifecycle: create room, add a real document, invite an external user, exchange the link, list documents", async () => {
  const { room } = await createDataRoom({ orgId, roomType: "investor", name: `LP Room ${RUN_ID}`, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(room.roomType, "investor");

  await addDocumentToRoom({ orgId, roomId: room._id, documentId, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const { token } = await inviteExternalUser({ orgId, roomId: room._id, externalEmail: EXTERNAL_EMAIL, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });

  const exchange = await exchangeRoomMagicLink(token);
  assert.equal(exchange.roomId, room._id.toString());

  const session = await getRoomSession(exchange.sessionToken);
  assert.ok(session);
  const { documents } = await listRoomDocuments(session);
  assert.equal(documents.length, 1);
  assert.equal(documents[0]._id.toString(), documentId.toString());

  const log = await getRoomAccessLog(orgId, room._id);
  assert.ok(log.some((l) => l.action === "LIST_DOCUMENTS" && l.externalEmail === EXTERNAL_EMAIL), "§229: the real access must be logged");
});

test("SECURITY: a magic link can only be exchanged once", async () => {
  const { room } = await createDataRoom({ orgId, roomType: "diligence", name: `Diligence Room ${RUN_ID}`, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const { token } = await inviteExternalUser({ orgId, roomId: room._id, externalEmail: EXTERNAL_EMAIL, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });

  const first = await exchangeRoomMagicLink(token);
  assert.ok(first.sessionToken);
  const second = await exchangeRoomMagicLink(token);
  assert.equal(second.error, "invalid_or_expired");
});

test("SECURITY §230: no cross-room retrieval -- a session only ever sees documents actually added to ITS OWN room", async () => {
  const { room: roomA } = await createDataRoom({ orgId, roomType: "audit", name: `Audit Room A ${RUN_ID}`, actorEmail: OWNER_EMAIL, membership: { role: "owner", email: OWNER_EMAIL, auditRole: "manager" } });
  const { room: roomB } = await createDataRoom({ orgId, roomType: "audit", name: `Audit Room B ${RUN_ID}`, actorEmail: OWNER_EMAIL, membership: { role: "owner", email: OWNER_EMAIL, auditRole: "manager" } });
  await addDocumentToRoom({ orgId, roomId: roomB._id, documentId, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP }); // only room B gets the document

  const { token } = await inviteExternalUser({ orgId, roomId: roomA._id, externalEmail: `roomA-${EXTERNAL_EMAIL}`, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const { sessionToken } = await exchangeRoomMagicLink(token);
  const session = await getRoomSession(sessionToken);
  const { documents } = await listRoomDocuments(session);
  assert.equal(documents.length, 0, "room A's session must never see room B's document");
});

test("SECURITY §230: no cross-tenant retrieval -- a session from org A cannot resolve a room in org B, even by ID", async () => {
  const { room } = await createDataRoom({ orgId: otherOrgId, roomType: "investor", name: `Other Org Room ${RUN_ID}`, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await addDocumentToRoom({ orgId: otherOrgId, roomId: room._id, documentId: otherOrgDocumentId, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const { token } = await inviteExternalUser({ orgId: otherOrgId, roomId: room._id, externalEmail: EXTERNAL_EMAIL, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const { sessionToken } = await exchangeRoomMagicLink(token);
  const session = await getRoomSession(sessionToken);

  // Simulate an attacker trying to reuse this real session against a
  // DIFFERENT org's document set by tampering the session object itself --
  // listRoomDocuments must still only resolve what session.orgId/roomId
  // actually say, proving the scoping is structural, not caller-trusted.
  const tampered = { ...session, orgId };
  const { documents } = await listRoomDocuments(tampered);
  assert.equal(documents.length, 0, "a session's own orgId must govern -- tampering it must not leak the real org's documents either way");
});

test("SECURITY §230: a closed room stops resolving sessions immediately, even before the token's own TTL elapses", async () => {
  const { room } = await createDataRoom({ orgId, roomType: "investor", name: `Closable Room ${RUN_ID}`, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const { token } = await inviteExternalUser({ orgId, roomId: room._id, externalEmail: EXTERNAL_EMAIL, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const { sessionToken } = await exchangeRoomMagicLink(token);

  const activeSession = await getRoomSession(sessionToken);
  assert.ok(activeSession, "sanity: session resolves before the room is closed");

  await closeDataRoom({ orgId, roomId: room._id, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const afterClose = await getRoomSession(sessionToken);
  assert.equal(afterClose, null, "a closed room must reject even a technically-unexpired session token");
});

test("SECURITY: revokeRoomAccess immediately ends access, and a revoked session cannot be resurrected", async () => {
  const { room } = await createDataRoom({ orgId, roomType: "diligence", name: `Revoke Room ${RUN_ID}`, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const { token } = await inviteExternalUser({ orgId, roomId: room._id, externalEmail: EXTERNAL_EMAIL, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const { sessionToken } = await exchangeRoomMagicLink(token);
  assert.ok(await getRoomSession(sessionToken));

  await revokeRoomAccess({ orgId, roomId: room._id, externalEmail: EXTERNAL_EMAIL, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(await getRoomSession(sessionToken), null);
});

test("removeDocumentFromRoom takes a document back out of the curated allowlist", async () => {
  const { room } = await createDataRoom({ orgId, roomType: "investor", name: `Curate Room ${RUN_ID}`, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await addDocumentToRoom({ orgId, roomId: room._id, documentId, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const { room: after } = await removeDocumentFromRoom({ orgId, roomId: room._id, documentId, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  assert.equal(after.documentIds.length, 0);
});

test("SECURITY: a plain member without the domain role cannot create a room or add a document", async () => {
  const plainMember = { role: "member", email: `plain-${RUN_ID}@example.com` };
  const createResult = await createDataRoom({ orgId, roomType: "investor", name: "Unauthorized Room", actorEmail: plainMember.email, membership: plainMember });
  assert.equal(createResult.status, 403);

  const { room } = await createDataRoom({ orgId, roomType: "investor", name: `Auth Test Room ${RUN_ID}`, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const addResult = await addDocumentToRoom({ orgId, roomId: room._id, documentId, actorEmail: plainMember.email, membership: plainMember });
  assert.equal(addResult.status, 403);
});
