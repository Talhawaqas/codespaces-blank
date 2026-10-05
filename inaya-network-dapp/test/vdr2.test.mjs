// test/vdr2.test.mjs -- Data Room 2.0 against the real database: settings, per-section visitors, NDA gate, view-only vs download, watermark data,
// pinned/locked/final documents, network restriction, DLP, questions, viewer signals, revoke, health, timeline, evidence.
// Run: node --env-file=.env.local --import ./test/_next-loader.mjs --test --test-force-exit --test-timeout=300000 test/vdr2.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { ObjectId } from "mongodb";
import { setup, teardown, makeChatOrg, c as cols } from "./_chat-fixtures.mjs";
import { getOrgCollections } from "../src/lib/orgs.js";
import { setOrgFeature } from "../src/lib/featureFlags.js";
import { createDataRoom, exchangeRoomMagicLink, acceptRoomNda, revokeRoomAccess } from "../src/lib/external-data-room.js";
import { exportDataRoomEvidence } from "../src/lib/dataRoomEvidence.js";
import { setShardFetcher } from "../src/lib/sharing/shares.js";
import * as V from "../src/lib/dataroom/vdr2.js";
import * as P from "../src/lib/governance/policies.js";

const T = { timeout: 300000 };
const CID_A = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi", CID_B = "bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
let org, db, owner, member, room, A, docs;
const code = (p) => p.then(() => null, (e) => e);
const mkDoc = async (filename, extra = {}) => (await cols.orgDocuments.insertOne({ orgId: org.orgId, departmentId: new ObjectId(), projectId: new ObjectId(), filename, fileHash: "0xv" + Math.random(), sizeBytes: 1234, cidAlpha: CID_A, cidBeta: CID_B, uploadedByEmail: owner.email, txHash: "0x", status: "DRAFT", accessLevel: "PRIVATE", createdAt: new Date().toISOString(), deletedAt: null, ...extra })).insertedId;
const visitorSession = async (invite) => { const ex = await exchangeRoomMagicLink(invite.token); assert.ok(ex.sessionToken); return ex.sessionToken; };
const base = () => ({ orgId: org.oid, roomId: String(room._id), membership: owner.membership, actorEmail: owner.email });

before(async () => {
  await setup(); db = (await getOrgCollections()).db; org = await makeChatOrg("vdr", { people: ["member"] }); owner = org.owner; member = org.member;
  await setOrgFeature({ orgId: org.oid, name: "FEATURE_DATA_ROOM_V2", enabled: true });
  setShardFetcher(async (cid) => JSON.stringify({ shard: cid === CID_A ? "ALPHA-CIPHER" : "BETA-CIPHER" }));
  docs = { nda: await mkDoc("nda-template.pdf"), fin: await mkDoc("financials-2026.xlsx", { classification: "CONFIDENTIAL" }), cap: await mkDoc("cap-table.xlsx"), legal: await mkDoc("articles.pdf"), v2: await mkDoc("financials-2026-v2.xlsx") };
  const r = await createDataRoom({ orgId: org.oid, roomType: "legal", name: "Series A", ndaRequired: true, ndaText: "Keep it confidential.", sections: ["Finance", "Legal"], actorEmail: owner.email, membership: owner.membership }); room = r.room;
});
after(async () => {
  for (const n of ["dataRooms", "dataRoomExternalMagicLinks", "dataRoomExternalSessions", "dataRoomAccessLog", "orgDocuments"]) await cols[n].deleteMany({ orgId: org.orgId }).catch(() => {});
  for (const n of ["data_room_questions", "data_room_views", "governance_policies", "dlp_events"]) await db.collection(n).deleteMany({ orgId: org.orgId }).catch(() => {});
  await teardown();
});

test("a room that never opts in is untouched, and v2 visitor calls refuse it", T, async () => {
  const inv = await code(V.inviteVisitors({ ...base(), emails: ["a@x.org"] })); assert.equal(inv.status, 409);
  const { inviteExternalUser } = await import("../src/lib/external-data-room.js");
  const v1 = await inviteExternalUser({ orgId: org.oid, roomId: String(room._id), externalEmail: "old@x.org", actorEmail: owner.email, membership: owner.membership });
  const tok = (await exchangeRoomMagicLink(v1.token)).sessionToken; assert.equal((await code(V.listVisitorDocuments({ token: tok }))).status, 409);
});

test("settings: validated, permission-checked, existing documents carried over", T, async () => {
  assert.equal((await code(V.applyRoomSettings({ ...base(), membership: member.membership, settings: {} }))).status, 403);
  assert.equal((await code(V.applyRoomSettings({ ...base(), settings: { ipAllow: ["nope"] } }))).status, 400);
  assert.equal((await code(V.applyRoomSettings({ ...base(), settings: { defaultPermission: "edit" } }))).status, 400);
  const r = await V.applyRoomSettings({ ...base(), settings: { watermark: true, defaultPermission: "view", sessionHours: 48 } }); assert.equal(r.settings.sessionHours, 48);
  room = await cols.dataRooms.findOne({ _id: room._id }); assert.equal(room.v2, true); assert.deepEqual(room.docSettings, []);
});

test("bulk document management: sections, permissions, missing ids, locks, final version, replace", T, async () => {
  const add1 = await V.bulkAddDocuments({ ...base(), documentIds: [String(docs.fin), String(docs.cap), String(new ObjectId())], section: "Finance" }); assert.equal(add1.added, 2); assert.equal(add1.missing.length, 1);
  assert.equal((await code(V.bulkAddDocuments({ ...base(), documentIds: [String(docs.legal)], section: "Nope" }))).status, 400);
  await V.bulkAddDocuments({ ...base(), documentIds: [String(docs.legal), String(docs.nda)], section: "Legal", permission: "download" });
  assert.equal((await V.bulkAddDocuments({ ...base(), documentIds: [String(docs.legal)], section: "Legal" })).added, 0, "duplicates are skipped");
  const upd = await V.updateDocuments({ ...base(), documentIds: [String(docs.cap)], patch: { permission: "download" } }); assert.equal(upd.updated, 1);
  await V.updateDocuments({ ...base(), documentIds: [String(docs.fin)], patch: { final: true } });
  const refused = await V.updateDocuments({ ...base(), documentIds: [String(docs.fin)], patch: { section: "Legal" } }); assert.equal(refused.updated, 0); assert.match(refused.refused[0].reason, /final version/);
  const rm = await V.removeDocuments({ ...base(), documentIds: [String(docs.fin)] }); assert.equal(rm.removed, 0); assert.match(rm.refused[0].reason, /final version/);
  assert.equal((await code(V.replaceDocumentVersion({ ...base(), oldDocumentId: String(docs.fin), newDocumentId: String(docs.v2) }))).status, 409);
  await V.updateDocuments({ ...base(), documentIds: [String(docs.cap)], patch: { locked: true } });
  assert.equal((await code(V.replaceDocumentVersion({ ...base(), oldDocumentId: String(docs.cap), newDocumentId: String(docs.v2) }))).status, 409);
  await V.updateDocuments({ ...base(), documentIds: [String(docs.cap)], patch: { locked: false } });
  await V.replaceDocumentVersion({ ...base(), oldDocumentId: String(docs.cap), newDocumentId: String(docs.v2) });
  room = await cols.dataRooms.findOne({ _id: room._id }); assert.ok(room.docSettings.some((d) => String(d.documentId) === String(docs.v2))); assert.equal(room.documentIds.length, 4, "the legacy list stays in step");
});

test("visitors: batch and group invites, per-section scope, NDA gate, role decides download", T, async () => {
  await V.saveVisitorGroup({ ...base(), name: "Lawyers", emails: ["lawyer@firm.com", "Paralegal@Firm.com", "bad"] });
  const fin = await V.inviteVisitors({ ...base(), emails: ["investor@fund.com"], allowedSections: ["Finance"], role: "viewer", expiresInHours: 9999 });
  const leg = await V.inviteVisitors({ ...base(), group: "Lawyers", allowedSections: ["Legal"], role: "downloader" }); assert.equal(leg.invites.length, 2);
  assert.equal((await code(V.inviteVisitors({ ...base(), emails: ["x@y.com"], allowedSections: ["Secret"] }))).status, 400);
  assert.equal((await code(V.inviteVisitors({ ...base(), emails: [] }))).status, 400);
  const ts = await visitorSession(fin.invites[0]); const lt = await visitorSession(leg.invites[0]);
  const sess = await cols.dataRoomExternalSessions.findOne({ roomId: room._id, externalEmail: "investor@fund.com" }); assert.deepEqual(sess.allowedSections, ["Finance"]); assert.ok(new Date(sess.expiresAt) < new Date(Date.now() + 49 * 3600_000), "invite hours are capped by the room");
  const gated = await V.listVisitorDocuments({ token: ts, ip: "203.0.113.9" }); assert.equal(gated.ndaRequired, true); assert.equal(gated.documents.length, 0);
  await acceptRoomNda(ts); await acceptRoomNda(lt);
  const finDocs = await V.listVisitorDocuments({ token: ts, ip: "203.0.113.9" }); assert.deepEqual(finDocs.documents.map((d) => d.filename).sort(), ["financials-2026-v2.xlsx", "financials-2026.xlsx"]);
  assert.ok(finDocs.documents.every((d) => !d.canDownload), "a viewer never gets download"); assert.equal(finDocs.documents.find((d) => d.filename === "financials-2026.xlsx").final, true);
  const legDocs = await V.listVisitorDocuments({ token: lt, ip: "203.0.113.9" }); assert.deepEqual(legDocs.documents.map((d) => d.filename).sort(), ["articles.pdf", "nda-template.pdf"]); assert.ok(legDocs.documents.every((d) => d.canDownload));
  assert.equal(JSON.stringify([finDocs, legDocs]).includes(CID_A), false, "no storage pointers");
  globalThis.__tok = { ts, lt };
});

test("opening a document: scope, mode, watermark data, short-lived view, ciphertext only, nothing across sessions", T, async () => {
  const { ts, lt } = globalThis.__tok;
  assert.equal((await code(V.openVisitorDocument({ token: ts, documentId: String(docs.legal), ip: "203.0.113.9" }))).status, 404, "another section is invisible");
  const o = await V.openVisitorDocument({ token: ts, documentId: String(docs.fin), ip: "203.0.113.9" });
  assert.equal(o.mode, "view"); assert.equal(o.final, true); assert.ok(o.watermark.lines.includes("investor@fund.com")); assert.match(o.watermark.lines[2], /UTC$/); assert.ok(new Date(o.expiresAt) > new Date());
  const a = await V.readVisitorContent({ token: ts, viewId: o.viewId, part: "alpha" }); assert.equal(JSON.parse(a.content).shard, "ALPHA-CIPHER");
  assert.equal(JSON.stringify([o, a]).includes(CID_A), false);
  assert.equal((await code(V.readVisitorContent({ token: lt, viewId: o.viewId, part: "alpha" }))).status, 401, "a view id is tied to its visitor");
  assert.equal((await code(V.readVisitorContent({ token: ts, viewId: "bogus", part: "alpha" }))).status, 401);
  assert.equal((await code(V.readVisitorContent({ token: ts, viewId: o.viewId, part: "gamma" }))).status, 400);
  const d = await V.openVisitorDocument({ token: lt, documentId: String(docs.legal), ip: "203.0.113.9" }); assert.equal(d.mode, "download");
  const expired = await db.collection("data_room_views").findOneAndUpdate({ documentId: docs.fin }, { $set: { expiresAt: new Date(Date.now() - 1000) } }); assert.ok(expired);
  assert.equal((await code(V.readVisitorContent({ token: ts, viewId: o.viewId, part: "beta" }))).status, 401, "an expired view stops serving");
  const log = await cols.dataRoomAccessLog.find({ roomId: room._id }).toArray(); assert.ok(log.some((l) => l.action === "OPENED_VIEW_ONLY") && log.some((l) => l.action === "OPENED_DOWNLOADABLE"));
});

test("network restriction (room and invite), device binding, and DLP are enforced when opening", T, async () => {
  await V.applyRoomSettings({ ...base(), settings: { watermark: true, defaultPermission: "view", sessionHours: 48, ipAllow: ["198.51.100.0/24"] } });
  const { ts } = globalThis.__tok;
  assert.equal((await code(V.listVisitorDocuments({ token: ts, ip: "203.0.113.9" }))).status, 403);
  assert.equal((await code(V.openVisitorDocument({ token: ts, documentId: String(docs.fin), ip: "203.0.113.9" }))).status, 403);
  assert.ok((await V.openVisitorDocument({ token: ts, documentId: String(docs.fin), ip: "198.51.100.7" })).viewId);
  assert.ok((await cols.dataRoomAccessLog.find({ roomId: room._id }).toArray()).some((l) => l.action === "DENIED_NETWORK"));
  await V.applyRoomSettings({ ...base(), settings: { watermark: true, defaultPermission: "view", sessionHours: 48, requireDeviceBinding: true } });
  assert.equal((await code(V.openVisitorDocument({ token: ts, documentId: String(docs.fin), ip: "1.1.1.1" }))).status, 403, "a device id is required");
  assert.ok((await V.openVisitorDocument({ token: ts, documentId: String(docs.fin), ip: "1.1.1.1", deviceId: "dev-1" })).viewId);
  assert.equal((await code(V.openVisitorDocument({ token: ts, documentId: String(docs.fin), ip: "1.1.1.1", deviceId: "dev-2" }))).status, 403, "the room is tied to the first device");
  await V.applyRoomSettings({ ...base(), settings: { watermark: true, defaultPermission: "view", sessionHours: 48 } });
  const pol = await P.createPolicy({ orgId: org.oid, actorEmail: owner.email, membership: owner.membership, type: "dlp", name: "rooms", config: { rules: [{ id: "no-conf", name: "Confidential never in rooms", action: "DENY", when: { actions: ["preview"], classification: ["CONFIDENTIAL"], shareTypes: ["room"] }, message: "Confidential files cannot be viewed in a data room." }] } });
  await P.publishPolicy({ orgId: org.oid, policyId: pol.policyId, actorEmail: owner.email, membership: owner.membership });
  const blocked = await code(V.openVisitorDocument({ token: ts, documentId: String(docs.fin), ip: "1.1.1.1", deviceId: "dev-1" })); assert.equal(blocked.status, 403); assert.match(blocked.message, /Confidential files cannot be viewed/);
  await P.retirePolicy({ orgId: org.oid, policyId: pol.policyId, actorEmail: owner.email, membership: owner.membership, reason: "test" });
  assert.ok((await V.openVisitorDocument({ token: ts, documentId: String(docs.fin), ip: "1.1.1.1", deviceId: "dev-1" })).viewId);
});

test("questions are private to the asker; staff see and answer them; viewer signals are limited to known types and rate limited", T, async () => {
  const { ts, lt } = globalThis.__tok;
  assert.equal((await code(V.askQuestion({ token: ts, text: "" }))).status, 400);
  assert.equal((await code(V.askQuestion({ token: ts, documentId: String(docs.legal), text: "x" }))).status, 404, "cannot ask about a document you cannot see");
  const q = await V.askQuestion({ token: ts, documentId: String(docs.fin), text: "Is Q4 audited?" });
  assert.equal((await V.listMyQuestions({ token: lt })).questions.length, 0); assert.equal((await V.listMyQuestions({ token: ts })).questions.length, 1);
  const staff = await V.listQuestions({ ...base(), status: "open" }); assert.equal(staff.questions[0].asker, "investor@fund.com");
  assert.equal((await code(V.answerQuestion({ ...base(), membership: member.membership, questionId: q.questionId, text: "Yes" }))).status, 403);
  await V.answerQuestion({ ...base(), questionId: q.questionId, text: "Yes, by an external firm." });
  assert.equal((await V.listMyQuestions({ token: ts })).questions[0].answer, "Yes, by an external firm.");
  const o = await V.openVisitorDocument({ token: ts, documentId: String(docs.fin), ip: "1.1.1.1", deviceId: "dev-1" });
  assert.equal((await code(V.recordViewerSignal({ token: ts, viewId: o.viewId, type: "HACK" }))).status, 400);
  assert.equal((await code(V.recordViewerSignal({ token: lt, viewId: o.viewId, type: "PRINT_ATTEMPT" }))).status, 404);
  for (let i = 0; i < 34; i++) await V.recordViewerSignal({ token: ts, viewId: o.viewId, type: "WINDOW_BLURRED" });
  const signals = (await cols.dataRoomAccessLog.find({ roomId: room._id, action: "SIGNAL_WINDOW_BLURRED" }).toArray()).length; assert.ok(signals <= 30 && signals >= 1, `signals bounded (${signals})`);
});

test("health, timeline, revoke and the evidence package", T, async () => {
  const h = await V.roomHealth(base()); assert.equal(h.v2, true); assert.equal(h.documents, 4); assert.equal(h.final, 1); assert.ok(h.visitors.active >= 3); assert.equal(h.visitors.ndaAccepted, 2); assert.ok(h.warnings.some((w) => /network restriction/.test(w)));
  const tl = await V.roomTimeline(base()); assert.ok(tl.events.some((e) => e.kind === "admin" && e.what === "VDR2_SETTINGS_APPLIED")); assert.ok(tl.events.some((e) => e.kind === "visitor" && e.what === "QUESTION_ASKED"));
  const vis = await V.listVisitors(base()); assert.ok(vis.visitors.find((v) => v.email === "investor@fund.com").allowedSections.includes("Finance"));
  const { ts } = globalThis.__tok;
  await revokeRoomAccess({ orgId: org.oid, roomId: String(room._id), externalEmail: "investor@fund.com", actorEmail: owner.email, membership: owner.membership });
  assert.equal((await code(V.listVisitorDocuments({ token: ts, ip: "1.1.1.1" }))).status, 401, "a revoked visitor is out immediately");
  const ev = await exportDataRoomEvidence({ orgId: org.oid, roomId: String(room._id), actorEmail: owner.email, membership: owner.membership });
  assert.ok(ev.evidence.exportHash); assert.equal(ev.evidence.dataRoom2.documents.length, 4); assert.equal(ev.evidence.dataRoom2.questions.answered, 1); assert.ok(ev.evidence.lifecycleEvents.some((e) => e.action === "EXTERNAL_ACCESS_REVOKED"), "the revocation stays in the evidence even though the session is deleted");
  assert.equal(JSON.stringify(ev).includes("Is Q4 audited?"), false, "question text is not exported");
  await setOrgFeature({ orgId: org.oid, name: "FEATURE_DATA_ROOM_V2", enabled: false });
  const lt = globalThis.__tok.lt; assert.equal((await code(V.listVisitorDocuments({ token: lt, ip: "1.1.1.1" }))).status, 404, "turning the feature off closes the v2 surface");
});
