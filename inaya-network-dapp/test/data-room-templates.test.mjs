// test/data-room-templates.test.mjs
//
// Modular Enterprise Adoption Features SOW, Feature 2 — Zero-Knowledge
// Data Room Templates: template CRUD, cloning a built-in example,
// creating a room from a template, section tagging, NDA gating, and
// evidence export. Real database, same fixture conventions as
// test/external-data-room.test.mjs.
//
// Run with: node --env-file=.env.local --test test/data-room-templates.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import mongoClientPromise from "../src/lib/mongodb.js";
import { createDataRoomTemplate, cloneBuiltinTemplate, listDataRoomTemplates, updateDataRoomTemplate, createRoomFromTemplate, BUILTIN_TEMPLATES } from "../src/lib/dataRoomTemplates.js";
import { addDocumentToRoom, inviteExternalUser, exchangeRoomMagicLink, getRoomSession, listRoomDocuments, acceptRoomNda } from "../src/lib/external-data-room.js";
import { exportDataRoomEvidence } from "../src/lib/dataRoomEvidence.js";
import { canonicalizeForExport } from "../src/lib/evidenceExporter.js";
import { createHash } from "node:crypto";

const RUN_ID = randomUUID().slice(0, 8);
const OWNER_EMAIL = `drt-owner-${RUN_ID}@example.com`;
const STAFF_EMAIL = `drt-staff-${RUN_ID}@example.com`;
const OWNER_MEMBERSHIP = { role: "owner", email: OWNER_EMAIL };
const STAFF_MEMBERSHIP = { role: "member", email: STAFF_EMAIL, departmentIds: [] };
const EXTERNAL_EMAIL = `drt-external-${RUN_ID}@example.com`;
let collections;
let orgId, documentId;

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
  const now = new Date().toISOString();
  const orgResult = await collections.orgs.insertOne({ name: `Data Room Template Test ${RUN_ID} Co`, ownerEmail: OWNER_EMAIL, createdAt: now });
  orgId = orgResult.insertedId;
  const docResult = await collections.orgDocuments.insertOne({ orgId, title: `Cap Table ${RUN_ID}`, fileHash: `fake-hash-${RUN_ID}`, createdAt: now, deletedAt: null });
  documentId = docResult.insertedId;
});

after(async () => {
  await Promise.all([
    collections.orgs.deleteMany({ _id: orgId }),
    collections.orgDocuments.deleteMany({ _id: documentId }),
    collections.dataRooms.deleteMany({ orgId }),
    collections.dataRoomTemplates.deleteMany({ orgId }),
    collections.dataRoomExternalMagicLinks.deleteMany({ orgId }),
    collections.dataRoomExternalSessions.deleteMany({ orgId }),
    collections.dataRoomAccessLog.deleteMany({ orgId }),
    collections.orgActivity.deleteMany({ orgId }),
  ]);
  const client = await mongoClientPromise;
  await client.close();
});

test("createDataRoomTemplate persists a real, editable template; only an owner/admin can create one", async () => {
  const denied = await createDataRoomTemplate({ orgId, name: "X", roomType: "investor", actorEmail: STAFF_EMAIL, membership: STAFF_MEMBERSHIP });
  assert.equal(denied.status, 403);

  const { template } = await createDataRoomTemplate({
    orgId, name: "Series A Room", description: "Custom template", roomType: "investor",
    sections: ["Financials", "Legal"], ndaRequired: true, ndaText: "Standard NDA", actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP,
  });
  assert.equal(template.name, "Series A Room");
  assert.deepEqual(template.sections, ["Financials", "Legal"]);
  assert.equal(template.ndaRequired, true);
});

test("cloneBuiltinTemplate copies one of the SOW's named examples into a real org template", async () => {
  const { template } = await cloneBuiltinTemplate({ orgId, builtinKey: "fundraising", actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });
  assert.equal(template.name, BUILTIN_TEMPLATES.fundraising.name);
  assert.deepEqual(template.sections, BUILTIN_TEMPLATES.fundraising.sections);
  assert.equal(template.clonedFromBuiltin, "fundraising");

  const list = await listDataRoomTemplates(orgId);
  assert.ok(list.some((t) => t._id.toString() === template._id.toString()));
});

test("createRoomFromTemplate instantiates a real room with the template's sections and NDA requirement", async () => {
  const { template } = await createDataRoomTemplate({
    orgId, name: "M&A Template", roomType: "diligence", sections: ["Corporate", "Financial"], ndaRequired: true, ndaText: "NDA text", actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP,
  });
  const { room } = await createRoomFromTemplate({ orgId, templateId: template._id, name: "Project Falcon", actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });
  assert.equal(room.roomType, "diligence");
  assert.deepEqual(room.sections, ["Corporate", "Financial"]);
  assert.equal(room.ndaRequired, true);
  assert.equal(room.templateId.toString(), template._id.toString());
});

test("editing a template never changes a room already created from it", async () => {
  const { template } = await createDataRoomTemplate({ orgId, name: "Legal Template", roomType: "legal", sections: ["Agreements"], actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });
  const { room } = await createRoomFromTemplate({ orgId, templateId: template._id, name: "Matter 123", actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });
  assert.deepEqual(room.sections, ["Agreements"]);

  await updateDataRoomTemplate({ orgId, templateId: template._id, sections: ["Agreements", "Correspondence"], actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });

  const unchangedRoom = await collections.dataRooms.findOne({ _id: room._id });
  assert.deepEqual(unchangedRoom.sections, ["Agreements"], "an already-created room must keep the sections it was instantiated with");
});

test("a document added with an invalid section (not one of the room's own sections) is rejected", async () => {
  const { template } = await createDataRoomTemplate({ orgId, name: "Strict Template", roomType: "investor", sections: ["Financial"], actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });
  const { room } = await createRoomFromTemplate({ orgId, templateId: template._id, name: "Strict Room", actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });

  const rejected = await addDocumentToRoom({ orgId, roomId: room._id, documentId, section: "NotARealSection", actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });
  assert.equal(rejected.status, 400);

  const accepted = await addDocumentToRoom({ orgId, roomId: room._id, documentId, section: "Financial", actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });
  assert.ok(accepted.room);
});

test("NDA gate: an ndaRequired room serves zero documents until the external session accepts the NDA (SECURITY)", async () => {
  const { template } = await createDataRoomTemplate({ orgId, name: "NDA Template", roomType: "investor", sections: ["Financial"], ndaRequired: true, ndaText: "You agree to keep this confidential.", actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });
  const { room } = await createRoomFromTemplate({ orgId, templateId: template._id, name: "NDA Room", actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });
  await addDocumentToRoom({ orgId, roomId: room._id, documentId, section: "Financial", actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });

  const { token } = await inviteExternalUser({ orgId, roomId: room._id, externalEmail: EXTERNAL_EMAIL, actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });
  const exchange = await exchangeRoomMagicLink(token);
  const session = await getRoomSession(exchange.sessionToken);

  const beforeAccept = await listRoomDocuments(session);
  assert.equal(beforeAccept.documents.length, 0, "no documents may be served before NDA acceptance");
  assert.equal(beforeAccept.ndaRequired, true);
  assert.equal(beforeAccept.ndaText, "You agree to keep this confidential.");

  const acceptance = await acceptRoomNda(exchange.sessionToken);
  assert.ok(acceptance.accepted);
  assert.ok(acceptance.ndaAcceptedAt);

  const refreshedSession = await getRoomSession(exchange.sessionToken);
  const afterAccept = await listRoomDocuments(refreshedSession);
  assert.equal(afterAccept.documents.length, 1, "documents must be served once the same session has accepted the NDA");
  assert.equal(afterAccept.documents[0].section, "Financial", "the document's section tag must be surfaced to the reviewer");
});

test("a room with no NDA requirement serves documents immediately, unaffected by the NDA feature", async () => {
  const { template } = await createDataRoomTemplate({ orgId, name: "No NDA Template", roomType: "legal", sections: [], ndaRequired: false, actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });
  const { room } = await createRoomFromTemplate({ orgId, templateId: template._id, name: "Open Room", actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });
  await addDocumentToRoom({ orgId, roomId: room._id, documentId, actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });

  const { token } = await inviteExternalUser({ orgId, roomId: room._id, externalEmail: EXTERNAL_EMAIL, actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });
  const exchange = await exchangeRoomMagicLink(token);
  const session = await getRoomSession(exchange.sessionToken);
  const { documents, ndaRequired } = await listRoomDocuments(session);
  assert.equal(ndaRequired, undefined);
  assert.equal(documents.length, 1);
});

test("evidence export produces a real, independently-recomputable hash and self-audits its own generation", async () => {
  const { template } = await createDataRoomTemplate({ orgId, name: "Evidence Template", roomType: "audit", sections: [], actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });
  const { room } = await createRoomFromTemplate({ orgId, templateId: template._id, name: "Evidence Room", actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });
  await addDocumentToRoom({ orgId, roomId: room._id, documentId, actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });

  const { evidence } = await exportDataRoomEvidence({ orgId, roomId: room._id, actorEmail: OWNER_EMAIL, membership: OWNER_MEMBERSHIP });
  assert.equal(evidence.roomIdentifier, room._id.toString());
  assert.ok(evidence.exportHash);
  assert.ok(evidence.lifecycleEvents.some((e) => e.action === "CREATED"));
  assert.ok(evidence.lifecycleEvents.some((e) => e.action === "DOCUMENT_ADDED"));

  const { exportHash, ...body } = evidence;
  const recomputed = createHash("sha256").update(canonicalizeForExport(body)).digest("hex");
  assert.equal(recomputed, exportHash);

  const auditRow = await collections.orgActivity.findOne({ orgId, recordType: "DATA_ROOM", recordId: room._id, action: "EVIDENCE_EXPORTED" });
  assert.ok(auditRow, "evidence export must self-audit through the existing audit chain");

  const denied = await exportDataRoomEvidence({ orgId, roomId: room._id, actorEmail: STAFF_EMAIL, membership: STAFF_MEMBERSHIP });
  assert.equal(denied.status, 403);
});
