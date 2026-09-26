// test/identity-engine.test.mjs -- Identity Integration: the joiner / mover / leaver engine and the revocation state machine (SOW §50 A-G,
// §45 lifecycle races, §46 idempotency and ordering). Real MongoDB, real membership rules, real audit chain and Evidence Graph.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server.js";
import { setup, makeIdentityOrg, ev, cookieFor, cleanup, RUN, c, ic } from "./_identity-fixtures.mjs";
import { processEvent, restoreAccess } from "../src/lib/identity/engine.js";
import { revokeAccess, retryRevocation, __setRevocationFault } from "../src/lib/identity/revocation.js";
import { listGrants, explainAccess, addGrant, materialize } from "../src/lib/identity/grants.js";
import { flushEvidence } from "../src/lib/identity/record.js";
import { requireMembership, getMembership, SESSION_COOKIE, createSession } from "../src/lib/orgs.js";
import { createMapping } from "../src/lib/identity/mapping.js";
import { reviewAiAction, executeApprovedAiActions } from "../src/lib/ai-action-requests.js";
import { createApiKey } from "../src/lib/api-keys.js";
import { issueS3Credential } from "../src/lib/s3-compat/credentials.js";
import { ObjectId } from "mongodb";

let O; const mail = (n) => `idn-${RUN}-${n}@corp.example`;
const member = (email) => c.orgMembers.findOne({ orgId: O.orgId, email });
const P = () => O.provider;

before(async () => { await setup(); O = await makeIdentityOrg("eng"); });
after(async () => { await flushEvidence(); await cleanup(); });

test("A. joiner: identity verified, membership created, mapped access granted, audited, evidenced, notified; a duplicate creates nothing (§50 A, §46)", async () => {
  const alice = mail("alice");
  const e = ev(O, { type: "user.created", id: "obj-alice", email: alice, groups: ["Inaya-Finance"], t: 1 });
  const r = await processEvent({ provider: P(), event: e });
  assert.equal(r.status, "PROCESSED", JSON.stringify(r)); assert.equal(r.state, "COMPLETED");
  const m = await member(alice);
  assert.equal(m.status, "active"); assert.equal(m.role, "member");
  assert.deepEqual((m.departmentIds || []).map(String), [String(O.finance)]); assert.equal(m.financeRole, "staff");
  assert.ok(await c.projectMembers.findOne({ orgId: O.orgId, email: alice, projectId: O.pFin }), "project access provisioned");
  const ext = await ic.identityExternalUsers.findOne({ providerId: P()._id, externalObjectId: "obj-alice" });
  assert.equal(ext.inayaEmail, alice); assert.equal(ext.lifecycleState, "ACTIVE");
  const run = await ic.identityRuns.findOne({ _id: new ObjectId(String(r.runId)) });
  assert.equal(run.type, "JOINER"); assert.equal(run.state, "COMPLETED"); assert.ok(run.result.verification.every((v) => v.ok));
  assert.ok(await c.orgActivity.findOne({ orgId: O.orgId, recordType: "IDENTITY_LIFECYCLE", action: "IDENTITY_LIFECYCLE_COMPLETED" }), "in the audit log");
  assert.ok(await c.auditChainEntries.findOne({ orgId: O.orgId, action: "IDENTITY_LIFECYCLE_COMPLETED" }), "and in the tamper-evident chain");
  await flushEvidence();
  const graph = await c.businessEvents.findOne({ orgId: O.orgId, subjectType: "IDENTITY_LIFECYCLE", subjectId: run._id });
  assert.ok(graph && (graph.relationships || []).length >= 3, "Evidence Graph has the run with typed relationships");
  assert.ok(await ic.db.collection("notifications").findOne({ orgId: O.orgId, sourceModule: "identity" }), "administrators were notified");
  // the same event again, and a second 'created' with a new id, must not create a second person
  const again = await processEvent({ provider: P(), event: e });
  assert.equal(again.status, "DUPLICATE");
  const twice = await processEvent({ provider: P(), event: ev(O, { type: "user.created", id: "obj-alice", email: alice, groups: ["Inaya-Finance"], t: 2 }) });
  assert.equal(twice.status, "PROCESSED");
  assert.equal(await c.orgMembers.countDocuments({ orgId: O.orgId, email: alice }), 1);
  assert.equal(await ic.identityRuns.countDocuments({ orgId: O.orgId, eventId: e.eventId }), 1, "one run for one event");
});

test("B. leaver: frozen at once, sessions, credentials, permissions, shares revoked and independently verified; every API refuses the person (§50 B)", async () => {
  const bob = mail("bob");
  await processEvent({ provider: P(), event: ev(O, { type: "user.created", id: "obj-bob", email: bob, t: 10 }) });
  // things Bob has and made
  const sess = await createSession(bob);
  const key = await createApiKey({ orgId: O.oid, label: "bob's key", actorEmail: bob });
  const s3 = await issueS3Credential({ owner: { type: "org", orgId: O.orgId }, label: "bob s3", actorEmail: bob });
  const docId = new ObjectId();
  await c.documentPermissions.insertOne({ orgId: O.orgId, documentId: docId, email: bob, level: "EDIT" });
  await c.documentShares.insertOne({ orgId: O.orgId, documentId: docId, tokenHash: "h", createdByEmail: bob, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(), revokedAt: null });
  assert.ok(await getMembership(O.oid, bob), "active before");

  const r = await processEvent({ provider: P(), event: ev(O, { type: "user.disabled", id: "obj-bob", email: bob, t: 20, enabled: false }) });
  assert.equal(r.status, "PROCESSED", JSON.stringify(r)); assert.equal(r.state, "COMPLETED");
  const run = await ic.identityRuns.findOne({ _id: new ObjectId(String(r.runId)) });
  assert.equal(run.type, "LEAVER"); assert.equal(run.result.revocation.state, "REVOCATION_COMPLETE");
  for (const step of ["FREEZE", "SESSIONS", "CREDENTIALS", "PERMISSIONS", "SHARING", "BREAK_GLASS"]) assert.equal(run.result.revocation.steps[step].status, "VERIFIED", step);

  // verified against the real stores
  const m = await member(bob);
  assert.equal(m.status, "revoked"); assert.deepEqual(m.departmentIds, []); assert.equal(m.financeRole, undefined); assert.equal(m.role, "member");
  assert.equal(await getMembership(O.oid, bob), null, "the exact lookup every org route uses now returns nothing");
  const rq = await requireMembership(new NextRequest("http://localhost/x", { headers: { cookie: `${SESSION_COOKIE}=${sess.sessionToken}` } }), O.oid);
  assert.equal(rq.status, 401, "the session itself is gone");
  const s2 = await createSession(bob); // even a brand-new valid session cannot reach the organization
  const rq2 = await requireMembership(new NextRequest("http://localhost/x", { headers: { cookie: `${SESSION_COOKIE}=${s2.sessionToken}` } }), O.oid);
  assert.equal(rq2.status, 403, "fail closed at the API boundary even with a valid session");
  assert.ok((await c.apiKeys.findOne({ orgId: O.orgId, createdByEmail: bob })).revokedAt);
  assert.ok((await ic.db.collection("s3_credentials").findOne({ accessKeyId: s3.accessKeyId })).revokedAt);
  assert.equal(await c.projectMembers.countDocuments({ orgId: O.orgId, email: bob }), 0);
  assert.equal(await c.documentPermissions.countDocuments({ orgId: O.orgId, email: bob }), 0);
  assert.ok((await c.documentShares.findOne({ orgId: O.orgId, createdByEmail: bob })).revokedAt);
  assert.equal(await listGrants({ orgId: O.oid, email: bob }).then((g) => g.length), 0);
  void key;
  // revoking twice is one effective revocation
  const again = await revokeAccess({ orgId: O.oid, email: bob, trigger: "manual" });
  assert.equal(again.revocation.noop, true);
  assert.equal(await ic.identityRevocations.countDocuments({ orgId: O.orgId, email: bob }), 1);
});

test("C. mover Finance -> Legal: obsolete external access removed, new added, manual and unrelated access preserved (§50 C, §12)", async () => {
  const carol = mail("carol");
  await processEvent({ provider: P(), event: ev(O, { type: "user.created", id: "obj-carol", email: carol, t: 30 }) });
  // a person's own manual override and pre-existing access must survive the move
  await addGrant({ orgId: O.oid, email: carol, kind: "hrRole", value: "staff", source: "INAYA_MANUAL_OVERRIDE", reason: "covers HR queries", actor: O.admin });
  await materialize({ orgId: O.oid, email: carol });
  const r = await processEvent({ provider: P(), event: ev(O, { type: "user.updated", id: "obj-carol", email: carol, groups: ["Inaya-Legal"], extra: { department: "Legal" }, t: 40 }) });
  assert.equal(r.status, "PROCESSED", JSON.stringify(r)); assert.equal(r.state, "COMPLETED");
  const m = await member(carol);
  assert.deepEqual((m.departmentIds || []).map(String), [String(O.legal)], "Finance removed, Legal added");
  assert.equal(m.financeRole, undefined, "the finance role came from the Finance group only");
  assert.equal(m.hrRole, "staff", "the manual override survived");
  assert.equal(await c.projectMembers.countDocuments({ orgId: O.orgId, email: carol, projectId: O.pFin }), 0);
  assert.equal(await c.projectMembers.countDocuments({ orgId: O.orgId, email: carol, projectId: O.pLegal }), 1);
  const ex = await explainAccess({ orgId: O.oid, email: carol });
  const src = Object.fromEntries(ex.grants.filter((g) => g.status === "ACTIVE").map((g) => [`${g.kind}:${g.value}`, g.sourceLabel]));
  assert.equal(src["hrRole:staff"], "INAYA MANUAL OVERRIDE"); assert.equal(src[`department:${O.legal}`], "ENTRA");
});

test("existing access is never wiped: a member who already exists is linked and keeps what they had (§12, §13)", async () => {
  const dan = O.member ? await O.member("dan", { role: "member", departmentIds: [O.legal], hrRole: "manager" }) : null;
  const r = await processEvent({ provider: P(), event: ev(O, { type: "user.created", id: "obj-dan", email: dan, groups: ["Inaya-Finance"], t: 50 }) });
  assert.equal(r.status, "PROCESSED", JSON.stringify(r));
  const m = await member(dan);
  assert.equal(m.hrRole, "manager"); assert.ok((m.departmentIds || []).map(String).includes(String(O.legal)) && (m.departmentIds || []).map(String).includes(String(O.finance)));
  const ext = await ic.identityExternalUsers.findOne({ providerId: P()._id, externalObjectId: "obj-dan" });
  assert.equal(ext.inayaEmail, dan);
});

test("stale, out-of-order and racing events can never restore access: disable -> update -> enable -> disable ends disabled (§45, §46)", async () => {
  const erin = mail("erin"); const id = "obj-erin";
  await processEvent({ provider: P(), event: ev(O, { type: "user.created", id, email: erin, t: 100 }) });
  const dis1 = ev(O, { type: "user.disabled", id, email: erin, t: 110, enabled: false });
  const upd = ev(O, { type: "user.updated", id, email: erin, t: 120, groups: ["Inaya-Finance"] });
  const en = ev(O, { type: "user.enabled", id, email: erin, t: 130, enabled: true });
  const dis2 = ev(O, { type: "user.disabled", id, email: erin, t: 140, enabled: false });
  // deliver in a hostile order and concurrently
  const results = await Promise.all([dis2, upd, en, dis1].map((e) => processEvent({ provider: P(), event: e })));
  assert.ok(results.every((r) => ["PROCESSED", "STALE", "PENDING"].includes(r.status)), JSON.stringify(results.map((r) => r.status)));
  // parked events (lock contention) are retried, like the worker does
  for (const r of results.filter((x) => x.status === "PENDING")) void r;
  const stored = await ic.identityEvents.find({ providerId: P()._id, externalId: id, status: "PENDING" }).toArray();
  for (const row of stored) await processEvent({ provider: P(), event: { ...row.event }, retry: true });
  const m = await member(erin);
  assert.equal(m.status, "revoked", "the final state is disabled");
  const ext = await ic.identityExternalUsers.findOne({ providerId: P()._id, externalObjectId: id });
  assert.ok(["DISABLED", "REVOKED"].includes(ext.lifecycleState));
  // later stale events (older than the last disable) change nothing
  const stale = await processEvent({ provider: P(), event: ev(O, { type: "user.enabled", id, email: erin, t: 135, enabled: true }) });
  assert.equal(stale.status, "STALE");
  assert.equal((await member(erin)).status, "revoked");
  // an enable that IS newer does not restore either: policy restoreOnEnable=manual_review parks it for a person
  const newer = await processEvent({ provider: P(), event: ev(O, { type: "user.enabled", id, email: erin, t: 200, enabled: true }) });
  assert.equal(newer.status, "PROCESSED"); assert.equal(newer.state, "AWAITING_REVIEW");
  assert.equal((await member(erin)).status, "revoked", "still revoked until a person approves");
});

test("restore: a person restores access explicitly and it is RE-DERIVED from the source, not resurrected from the old snapshot", async () => {
  const erin = mail("erin");
  const still = await restoreAccess({ orgId: O.oid, email: erin, actor: O.admin });
  assert.equal(still.restored, true, JSON.stringify(still));
  const m = await member(erin);
  assert.equal(m.status, "active");
  const ex = await explainAccess({ orgId: O.oid, email: erin });
  assert.ok(ex.grants.some((g) => g.status === "ACTIVE" && g.source === "ENTRA"), "access came from the directory policy again");
  assert.equal((await restoreAccess({ orgId: O.oid, email: erin, actor: O.admin })).noop, true, "restoring twice is harmless");
});

test("tenant binding, ordering ties and identity conflicts fail closed (§8, §45)", async () => {
  const other = ev(O, { type: "user.created", id: "obj-x", email: mail("x"), tenant: "some-other-tenant", t: 300 });
  const r = await processEvent({ provider: P(), event: other });
  assert.equal(r.status, "REJECTED"); assert.equal(r.reasonCode, "TENANT_MISMATCH");
  assert.equal(await c.orgMembers.countDocuments({ orgId: O.orgId, email: mail("x") }), 0, "nothing was created");
  assert.ok(await c.orgActivity.findOne({ orgId: O.orgId, action: "IDENTITY_EVENT_REJECTED" }), "audited");
  // two different objects claiming the same email: the second is a conflict, never merged
  const f1 = await processEvent({ provider: P(), event: ev(O, { type: "user.created", id: "obj-f1", email: mail("frank"), t: 310 }) });
  assert.equal(f1.status, "PROCESSED");
  const f2 = await processEvent({ provider: P(), event: ev(O, { type: "user.created", id: "obj-f2", email: mail("frank"), t: 311 }) });
  assert.equal(f2.status, "UNRESOLVED"); assert.equal(f2.resolution, "CONFLICT");
  assert.equal(await c.orgMembers.countDocuments({ orgId: O.orgId, email: mail("frank") }), 1);
  // an event with no email cannot create a person
  const noMail = ev(O, { type: "user.created", id: "obj-nomail", email: undefined, t: 320 });
  const nm = await processEvent({ provider: P(), event: noMail });
  assert.equal(nm.status, "PROCESSED"); assert.ok((await ic.identityRuns.findOne({ _id: new ObjectId(String(nm.runId)) })).plan.warnings.some((w) => /no email/i.test(w)));
  assert.equal(await c.orgMembers.countDocuments({ orgId: O.orgId, email: null }), 0);
});

test("F. partial revocation: one dependency fails -> PARTIAL, the person is already frozen, retry completes and verifies (§15, §50 F)", async () => {
  const gina = mail("gina");
  await processEvent({ provider: P(), event: ev(O, { type: "user.created", id: "obj-gina", email: gina, t: 400 }) });
  await createApiKey({ orgId: O.oid, label: "gina", actorEmail: gina });
  __setRevocationFault("CREDENTIALS", 1);
  const r = await processEvent({ provider: P(), event: ev(O, { type: "user.disabled", id: "obj-gina", email: gina, t: 410, enabled: false }) });
  assert.equal(r.state, "PARTIAL");
  const run = await ic.identityRuns.findOne({ _id: new ObjectId(String(r.runId)) });
  assert.equal(run.result.revocation.state, "REVOCATION_PARTIAL");
  assert.equal(run.result.revocation.steps.CREDENTIALS.status, "FAILED"); assert.equal(run.result.revocation.steps.FREEZE.status, "VERIFIED");
  assert.equal(await getMembership(O.oid, gina), null, "already blocked while the failed step waits");
  assert.ok(run.nextRetryAt, "a retry is scheduled");
  assert.ok(await ic.db.collection("notifications").findOne({ orgId: O.orgId, sourceId: String(run._id), severity: "critical" }), "administrators are told it is only partial");
  __setRevocationFault(null);
  const retry = await retryRevocation({ orgId: O.oid, email: gina });
  assert.equal(retry.revocation.state, "REVOCATION_COMPLETE");
  assert.equal(retry.revocation.steps.FREEZE.status, "VERIFIED");
  assert.ok((await c.apiKeys.findOne({ orgId: O.orgId, createdByEmail: gina })).revokedAt);
  assert.equal((await retryRevocation({ orgId: O.oid, email: gina })).status, 404, "nothing left to retry");
});

test("G. dry run shows exactly what would happen and mutates nothing (§37, §50 G)", async () => {
  const hank = mail("hank");
  const before = { m: await c.orgMembers.countDocuments({ orgId: O.orgId }), g: await ic.identityGrants.countDocuments({ orgId: O.orgId }), r: await ic.identityRuns.countDocuments({ orgId: O.orgId }), e: await ic.identityEvents.countDocuments({ orgId: O.orgId }), x: await ic.identityExternalUsers.countDocuments({ orgId: O.orgId }) };
  const r = await processEvent({ provider: P(), event: ev(O, { type: "user.created", id: "obj-hank", email: hank, groups: ["Inaya-Finance"], t: 500 }), dryRun: true });
  assert.equal(r.status, "DRY_RUN"); assert.equal(r.liveMutation, false);
  const ops = r.plan.ops.map((o) => o.op);
  assert.ok(ops.includes("CREATE_MEMBERSHIP") && ops.filter((o) => o === "GRANT").length >= 3, JSON.stringify(ops));
  const after = { m: await c.orgMembers.countDocuments({ orgId: O.orgId }), g: await ic.identityGrants.countDocuments({ orgId: O.orgId }), r: await ic.identityRuns.countDocuments({ orgId: O.orgId }), e: await ic.identityEvents.countDocuments({ orgId: O.orgId }), x: await ic.identityExternalUsers.countDocuments({ orgId: O.orgId }) };
  assert.deepEqual(after, before, "zero live mutation");
  // and the same event live does what the plan said
  const live = await processEvent({ provider: P(), event: ev(O, { type: "user.created", id: "obj-hank", email: hank, groups: ["Inaya-Finance"], t: 500 }) });
  assert.equal(live.state, "COMPLETED");
  const leaverPlan = await processEvent({ provider: P(), event: ev(O, { type: "user.disabled", id: "obj-hank", email: hank, enabled: false, t: 510 }), dryRun: true });
  assert.ok(leaverPlan.plan.ops.some((o) => o.op === "REVOKE_ACCESS"));
  assert.equal((await member(hank)).status, "active", "a dry-run leaver revokes nothing");
});

test("privileged grants from outside need a human: PENDING until approved and the delay passes; never applied to someone disabled meanwhile (§17, §38)", async () => {
  await createMapping({ orgId: O.oid, providerId: O.providerId, body: { name: "Domain admins", match: { type: "group", value: "Inaya-Admins" }, grants: [{ kind: "role", value: "admin" }] }, actorEmail: O.owner });
  const ivy = mail("ivy");
  const r = await processEvent({ provider: P(), event: ev(O, { type: "user.created", id: "obj-ivy", email: ivy, groups: ["Inaya-Admins"], t: 600 }) });
  assert.equal(r.status, "PROCESSED", JSON.stringify(r));
  assert.equal((await member(ivy)).role, "member", "the admin role has NOT been applied");
  const pending = (await listGrants({ orgId: O.oid, email: ivy })).find((g) => g.kind === "role" && g.value === "admin");
  assert.equal(pending.status, "PENDING_APPROVAL"); assert.ok(pending.requestId);
  const req = await c.aiActionRequests.findOne({ _id: new ObjectId(pending.requestId) });
  assert.equal(req.targetRecordType, "IDENTITY_LIFECYCLE"); assert.equal(req.riskLevel, "HIGH"); assert.equal(req.status, "PENDING_APPROVAL");
  // an approver approves; the standard delay still applies
  const rev = await reviewAiAction({ orgId: O.oid, requestId: String(req._id), decision: "approve", actorEmail: O.admin, note: "ok", canApprove: true });
  assert.ok(!rev.error, rev.error);
  const early = await executeApprovedAiActions({ orgId: O.orgId });
  assert.equal(early.executed, 0, "not before the delay");
  assert.equal((await member(ivy)).role, "member");
  await c.aiActionRequests.updateOne({ _id: req._id }, { $set: { unlockAt: new Date(Date.now() - 1000).toISOString() } });
  const done = await executeApprovedAiActions({ orgId: O.orgId });
  assert.equal(done.executed, 1, JSON.stringify(done));
  assert.equal((await member(ivy)).role, "admin");
  // a second person: approved, but disabled at the source before the delay elapses -> not applied
  const jay = mail("jay");
  await processEvent({ provider: P(), event: ev(O, { type: "user.created", id: "obj-jay", email: jay, groups: ["Inaya-Admins"], t: 610 }) });
  const jg = (await listGrants({ orgId: O.oid, email: jay })).find((g) => g.value === "admin");
  await reviewAiAction({ orgId: O.oid, requestId: jg.requestId, decision: "approve", actorEmail: O.admin, note: "ok", canApprove: true });
  await processEvent({ provider: P(), event: ev(O, { type: "user.disabled", id: "obj-jay", email: jay, enabled: false, t: 620 }) });
  await c.aiActionRequests.updateOne({ _id: new ObjectId(jg.requestId) }, { $set: { unlockAt: new Date(Date.now() - 1000).toISOString() } });
  const gone = await executeApprovedAiActions({ orgId: O.orgId });
  assert.equal(gone.executed, 0); assert.equal(gone.expired, 1, "an approval cannot resurrect access");
  assert.equal((await member(jay)).role, "member"); assert.equal((await member(jay)).status, "revoked");
});

test("owners are protected: never modified by mappings, and the only active owner cannot be revoked (§45)", async () => {
  const before = await member(O.owner);
  const r = await processEvent({ provider: P(), event: ev(O, { type: "user.created", id: "obj-owner", email: O.owner, groups: ["Inaya-Finance"], t: 700 }) });
  assert.equal(r.status, "PROCESSED");
  const after = await member(O.owner);
  assert.equal(after.role, "owner"); assert.deepEqual(after.departmentIds || [], before.departmentIds || [], "an owner's scopes are not rewritten");
  const kill = await processEvent({ provider: P(), event: ev(O, { type: "user.disabled", id: "obj-owner", email: O.owner, enabled: false, t: 710 }) });
  assert.equal(kill.status, "FAILED"); assert.equal((await member(O.owner)).status, "active", "the organization is not locked out");
  const run = await ic.identityRuns.findOne({ orgId: O.orgId, externalId: "obj-owner", type: "LEAVER" });
  assert.equal(run.failure.reasonCode, "LAST_OWNER");
});
