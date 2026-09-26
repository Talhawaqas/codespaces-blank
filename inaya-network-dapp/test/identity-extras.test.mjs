// test/identity-extras.test.mjs -- Identity Integration: reconciliation/drift (SOW 24), temporary access (30), access reviews (31), orphans and manager
// replacement (32, 33), bulk jobs (48), Digital Twin preview (41, 50 H), outbound events (22), SCIM (19), the Microsoft Graph pull (10, against a local
// stand-in for Microsoft), and the worker (47). Real MongoDB; the external world is played by the tests.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { NextRequest } from "next/server.js";
import { setup, makeIdentityOrg, ev, signedHeaders, cleanup, RUN, c, ic } from "./_identity-fixtures.mjs";
import { processEvent } from "../src/lib/identity/engine.js";
import { flushEvidence } from "../src/lib/identity/record.js";
import { reconcileSubjects, ingestSnapshot, remediateFindings } from "../src/lib/identity/reconcile.js";
import { grantTemporary, expireTemporary } from "../src/lib/identity/temporary.js";
import { createCampaign, decide, getCampaign } from "../src/lib/identity/reviews.js";
import { detectOrphans, resolveRemediation, analyzeManagerReplacement } from "../src/lib/identity/orphans.js";
import { createJob, processJobs, getJob } from "../src/lib/identity/jobs.js";
import { previewAccessRemoval } from "../src/lib/identity/twin.js";
import { createSubscription, processDeliveries, listDeliveries } from "../src/lib/identity/outbound.js";
import { revokeAccess, __setRevocationFault } from "../src/lib/identity/revocation.js";
import { runIdentityWorker, pullAndReconcile } from "../src/lib/identity/worker.js";
import { updateProvider, createProvider, getProviderById, providerView } from "../src/lib/identity/providers.js";
import { createMapping } from "../src/lib/identity/mapping.js";
import { createCredential } from "../src/lib/identity/credentials.js";
import { identityMetrics } from "../src/lib/identity/metrics.js";
import { requireMembership } from "../src/lib/orgs.js";
import { verifySignature } from "../src/lib/identity/normalize.js";
import * as scimRoute from "../src/app/api/scim/v2/[[...path]]/route.js";

process.env.WORKFLOW_HTTP_TEST_ALLOW_LOCAL = "1";
let O; let S; let SB;
const mail = (n) => `idn-${RUN}-${n}@corp.example`;
const J = (o) => JSON.stringify(o);
const mem = (org, email) => c.orgMembers.findOne({ orgId: org.orgId, email });
const join = async (org, key, groups = ["Inaya-Finance"], t = 1) => { const email = mail(key); const r = await processEvent({ provider: org.provider, event: ev(org, { type: "user.created", id: `obj-${key}`, email, groups, t }) }); assert.equal(r.status, "PROCESSED", J(r)); return email; };
const listen = (handler) => new Promise((res) => { const s = http.createServer(handler); s.listen(0, "127.0.0.1", () => res({ s, port: s.address().port })); });
const readAll = (req) => new Promise((res) => { let d = ""; req.on("data", (x) => (d += x)); req.on("end", () => res(d)); });

before(async () => { await setup(); O = await makeIdentityOrg("ext"); S = await makeIdentityOrg("scim", { kind: "scim", mappings: false }); SB = await makeIdentityOrg("scimb", { kind: "scim", mappings: false }); });
after(async () => { await flushEvidence(); await cleanup(); });

test("reconciliation: MATCH / DRIFT / CONFLICT / UNRESOLVED are reported, nothing is deleted, and remediation revokes only what is disabled at the source (SOW 24, 50)", async () => {
  const ok = await join(O, "rec-ok"); const stillActive = await join(O, "rec-dis");
  const sub = (key, extra = {}) => ({ externalId: `obj-${key}`, upn: mail(key), email: mail(key), groups: ["Inaya-Finance"], accountEnabled: true, ...extra });
  const subjects = [sub("rec-ok"), sub("rec-dis", { accountEnabled: false }), sub("rec-new"), sub("rec-ok2", { externalId: "obj-dup-1", email: mail("rec-ok") }), { externalId: "bad" + "\u0000", upn: "x" }];
  const r = await reconcileSubjects({ orgId: O.orgId, provider: O.provider, subjects, complete: false, actor: O.owner });
  const kinds = r.report.findings.map((f) => f.kind);
  assert.ok(kinds.includes("DISABLED_STILL_ACTIVE"), J(kinds)); assert.ok(kinds.includes("MISSING_IN_INAYA"));
  assert.ok(r.report.summary.MATCH >= 1 && r.report.summary.DRIFT >= 2, J(r.report.summary));
  assert.ok(r.report.summary.CONFLICT + r.report.summary.UNRESOLVED >= 1, "two directory objects claiming one email are never guessed");
  assert.equal((await mem(O, stillActive)).status, "active", "reporting never revokes by itself (policy autoRevokeDisabledOnDrift is off)");
  assert.equal((await mem(O, ok)).status, "active"); assert.equal(await c.orgMembers.countDocuments({ orgId: O.orgId, email: mail("rec-new") }), 0, "and never provisions by itself either");
  const crit = r.report.findings.find((f) => f.kind === "DISABLED_STILL_ACTIVE"); assert.equal(crit.suggestedAction, "REVOKE");
  const rem = await remediateFindings({ orgId: O.orgId, provider: O.provider, report: { _id: "manual", findings: r.report.findings }, kinds: ["DISABLED_STILL_ACTIVE"], actor: O.owner });
  assert.equal(rem.applied, 1); assert.equal((await mem(O, stillActive)).status, "revoked"); assert.equal((await mem(O, ok)).status, "active");
  // a complete snapshot, posted in chunks, also finds people who vanished from the directory
  const gone = await join(O, "rec-gone", ["Inaya-Legal"], 3);
  const chunk1 = await ingestSnapshot({ orgId: O.orgId, provider: O.provider, snapshotId: `snap-${RUN}-1`, users: [sub("rec-ok")], last: false, actor: O.owner }); assert.equal(chunk1.complete, false);
  const chunk2 = await ingestSnapshot({ orgId: O.orgId, provider: O.provider, snapshotId: `snap-${RUN}-1`, users: [sub("rec-new")], last: true, actor: O.owner });
  assert.equal(chunk2.complete, true); assert.ok(chunk2.report.findings.some((f) => f.kind === "ABSENT_FROM_DIRECTORY" && f.email === gone), "vanished from the directory but still active");
  assert.equal((await mem(O, gone)).status, "active", "still reported only");
  assert.ok((await ic.identityDriftReports.countDocuments({ orgId: O.orgId })) >= 2);
});

test("temporary/contractor access: time-boxed, sponsored, expires by itself, contractor membership fully revoked and verified (SOW 30, 42)", async () => {
  const owner = O.owner; const email = mail("contractor");
  const bad = await grantTemporary({ orgId: O.orgId, email, grants: [{ kind: "role", value: "admin" }], type: "CONTRACTOR", owner, purpose: "audit", expiresAt: new Date(Date.now() + 86400000).toISOString(), actor: owner, createMembership: true });
  assert.ok(bad.error, "privileged access cannot be time-boxed through this path");
  const noSponsor = await grantTemporary({ orgId: O.orgId, email, grants: [{ kind: "department", value: String(O.legal) }], type: "CONTRACTOR", owner: "nobody@x.example", purpose: "audit", expiresAt: new Date(Date.now() + 86400000).toISOString(), actor: owner, createMembership: true });
  assert.ok(noSponsor.error, "the sponsor must be an active member");
  const g = await grantTemporary({ orgId: O.orgId, email, grants: [{ kind: "department", value: String(O.legal) }, { kind: "project", value: String(O.pLegal) }], type: "CONTRACTOR", owner, purpose: "Contract review", expiresAt: new Date(Date.now() + 3600000).toISOString(), actor: owner, createMembership: true });
  assert.ok(g.grantSetId, J(g)); assert.equal(g.membershipCreated, true);
  let m = await mem(O, email); assert.equal(m.status, "active"); assert.deepEqual(m.departmentIds.map(String), [String(O.legal)]); assert.equal(m.temporary, true);
  assert.ok(await c.projectMembers.findOne({ orgId: O.orgId, email, projectId: O.pLegal }));
  const early = await expireTemporary({ orgIds: [O.oid] }); assert.equal((await mem(O, email)).status, "active", "not yet expired: untouched"); void early;
  await ic.identityGrants.updateMany({ orgId: O.orgId, email, source: "TEMPORARY" }, { $set: { expiresAt: new Date(Date.now() - 1000).toISOString() } });
  const out = await expireTemporary({ orgIds: [O.oid] }); assert.ok(out.people >= 1 && out.revokedMemberships >= 1, J(out));
  m = await mem(O, email); assert.equal(m.status, "revoked", "a contractor whose engagement ended has no access");
  assert.equal((await requireMembership(new NextRequest("http://localhost/x", { headers: { authorization: `Bearer ${(await (await import("../src/lib/orgs.js")).createSession(email)).sessionToken}` } }), O.oid)).status, 403);
  assert.equal(await c.projectMembers.countDocuments({ orgId: O.orgId, email, identityManaged: true }), 0);
  const run = await ic.identityRuns.findOne({ orgId: O.orgId, email, type: "TEMP_EXPIRY" }); assert.ok(run && run.state === "COMPLETED");
  // an existing member's temporary access expires but their permanent access is untouched
  const perm = await join(O, "perm", ["Inaya-Finance"], 5);
  await grantTemporary({ orgId: O.orgId, email: perm, grants: [{ kind: "department", value: String(O.legal) }], type: "AUDITOR", owner, purpose: "Temporary auditor", expiresAt: new Date(Date.now() + 3600000).toISOString(), actor: owner });
  assert.ok((await mem(O, perm)).departmentIds.map(String).includes(String(O.legal)));
  await ic.identityGrants.updateMany({ orgId: O.orgId, email: perm, source: "TEMPORARY" }, { $set: { expiresAt: new Date(Date.now() - 1000).toISOString() } });
  await expireTemporary({ orgIds: [O.oid] });
  const after2 = await mem(O, perm); assert.equal(after2.status, "active"); assert.deepEqual(after2.departmentIds.map(String), [String(O.finance)]);
});

test("access reviews: approve / modify / revoke, nobody certifies themselves, every decision audited (SOW 31, 42)", async () => {
  const a = await join(O, "rv-a", ["Inaya-Finance"], 7); const b = await join(O, "rv-b", ["Inaya-Legal"], 8); const cc = await join(O, "rv-c", ["Inaya-Finance"], 9);
  const camp = await createCampaign({ orgId: O.orgId, name: "Q3 certification", scope: { role: "member" }, dueInDays: 7, actorEmail: O.owner });
  assert.ok(camp.review.items >= 3, J(camp));
  const det = await getCampaign({ orgId: O.orgId, reviewId: camp.review.reviewId });
  const item = (email) => det.items.find((i) => i.email === email);
  assert.ok(item(a).grants.length >= 1 && item(a).grants[0].source, "each grant carries its source");
  const owner = await c.orgMembers.findOne({ orgId: O.orgId, email: O.admin }); const ownerM = { ...owner };
  const dec = (email, body) => decide({ orgId: O.orgId, reviewId: camp.review.reviewId, itemId: item(email).itemId, actorEmail: O.admin, membership: ownerM, ...body });
  assert.equal((await dec(a, { decision: "APPROVE", note: "still needs it" })).decided, true);
  assert.equal((await dec(a, { decision: "APPROVE" })).status, 409, "an item is decided once");
  const grantToRemove = item(b).grants.find((g) => g.kind === "department");
  const mod = await dec(b, { decision: "MODIFY", removeGrantIds: [grantToRemove.id], note: "no longer on Legal" }); assert.equal(mod.decided, true, J(mod));
  assert.deepEqual((await mem(O, b)).departmentIds.map(String), [], "the modified grant is gone");
  const rev = await dec(cc, { decision: "REVOKE", note: "left the project" }); assert.equal(rev.result.revocation.state, "REVOCATION_COMPLETE");
  assert.equal((await mem(O, cc)).status, "revoked");
  const self = await decide({ orgId: O.orgId, reviewId: camp.review.reviewId, itemId: item(O.admin)?.itemId || "000000000000000000000000", decision: "APPROVE", actorEmail: O.admin, membership: ownerM });
  assert.ok(self.error, "reviewing yourself (or a missing item) is refused");
  const asMember = await decide({ orgId: O.orgId, reviewId: camp.review.reviewId, itemId: item(a).itemId, decision: "APPROVE", actorEmail: a, membership: { role: "member" } }); assert.equal(asMember.status, 403);
  assert.ok(await c.orgActivity.findOne({ orgId: O.orgId, action: "IDENTITY_REVIEW_REVOKE" })); assert.ok(await c.orgActivity.findOne({ orgId: O.orgId, action: "IDENTITY_REVIEW_MODIFY" }));
});

test("orphans and manager replacement: work owned by someone who left is found and a human reassigns it; analysis changes nothing (SOW 32, 33, 42)", async () => {
  const mgr = await join(O, "mgr", ["Inaya-Finance"], 11); const peer = await join(O, "peer", ["Inaya-Finance"], 12);
  await c.orgMembers.updateOne({ orgId: O.orgId, email: mgr }, { $set: { financeRole: "manager" } });
  const task = await c.tasks.insertOne({ orgId: O.orgId, departmentId: O.finance, projectId: O.pFin, title: "Quarter close", status: "TODO", priority: "HIGH", assigneeEmail: mgr, dueDate: null, createdByEmail: O.owner, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deletedAt: null });
  const analysis = await analyzeManagerReplacement({ orgId: O.orgId, email: mgr });
  assert.equal(analysis.noChangesWereMade, true); assert.equal(analysis.openTasks, 1); assert.ok(analysis.managerAreas.includes("financeRole"));
  assert.equal((await c.tasks.findOne({ _id: task.insertedId })).assigneeEmail, mgr, "analysis reassigns nothing");
  await revokeAccess({ orgId: O.orgId, email: mgr, trigger: "test", actor: "test", mode: "full" });
  const det = await detectOrphans({ orgId: O.orgId, email: mgr }); assert.ok(det.created >= 1, J(det));
  assert.equal((await detectOrphans({ orgId: O.orgId, email: mgr })).created, 0, "detection is idempotent");
  assert.equal((await c.tasks.findOne({ _id: task.insertedId })).assigneeEmail, mgr, "and never reassigns silently");
  const rem = await ic.identityRemediations.findOne({ orgId: O.orgId, kind: "TASK", recordId: String(task.insertedId), status: "OPEN" }); assert.ok(rem);
  assert.ok((await resolveRemediation({ orgId: O.orgId, remediationId: String(rem._id), newOwner: "outsider@x.example", actor: O.owner })).error, "the new owner must be an active member");
  const done = await resolveRemediation({ orgId: O.orgId, remediationId: String(rem._id), newOwner: peer, note: "peer takes over", actor: O.owner }); assert.equal(done.resolved, true);
  assert.equal((await c.tasks.findOne({ _id: task.insertedId })).assigneeEmail, peer);
  assert.ok(await c.orgActivity.findOne({ orgId: O.orgId, action: "IDENTITY_ORPHAN_REASSIGNED" }));
});

test("bulk jobs: per-item state, one bad row does not stop the rest, resumable, dry run mutates nothing (SOW 48)", async () => {
  const u1 = await join(O, "job1", ["Inaya-Finance"], 13); const u2 = await join(O, "job2", ["Inaya-Finance"], 14);
  const dry = await createJob({ orgId: O.orgId, kind: "DISABLE", items: [{ email: u1 }], dryRun: true, actor: O.owner }); await processJobs({ jobId: dry.job.jobId, budget: 10 });
  assert.equal((await mem(O, u1)).status, "active", "a dry-run job changes nothing");
  assert.equal((await getJob({ orgId: O.orgId, jobId: dry.job.jobId })).status, "COMPLETED");
  const j = await createJob({ orgId: O.orgId, kind: "DISABLE", items: [{ email: u1, reason: "bulk" }, { email: "ghost@nowhere.example" }, { email: u2 }], actor: O.owner });
  assert.ok((await createJob({ orgId: O.orgId, kind: "DISABLE", items: [], actor: O.owner })).error); assert.ok((await createJob({ orgId: O.orgId, kind: "NUKE", items: [{ email: u1 }], actor: O.owner })).error);
  const first = await processJobs({ jobId: j.job.jobId, budget: 2 }); assert.equal(first.items, 2);
  let mid = await getJob({ orgId: O.orgId, jobId: j.job.jobId }); assert.equal(mid.status, "RUNNING", "partly done, resumable");
  await processJobs({ jobId: j.job.jobId, budget: 10 });
  const fin = await getJob({ orgId: O.orgId, jobId: j.job.jobId });
  assert.equal(fin.status, "PARTIAL", J(fin.totals)); assert.equal(fin.totals.completed, 2); assert.equal(fin.totals.failed, 1);
  assert.equal(fin.items.find((i) => i.state === "FAILED").error.klass, "PERMANENT");
  assert.equal((await mem(O, u1)).status, "revoked"); assert.equal((await mem(O, u2)).status, "revoked");
  const rerun = await processJobs({ jobId: j.job.jobId, budget: 10 }); assert.equal(rerun.items, 0, "a finished job is not processed again");
});

test("H. Digital Twin preview: what depends on the person is shown first; nothing changes (SOW 41, 50 H)", async () => {
  const p = await join(O, "twin", ["Inaya-Finance"], 15);
  await c.tasks.insertOne({ orgId: O.orgId, departmentId: O.finance, projectId: O.pFin, title: "Twin task", status: "IN_PROGRESS", priority: "MEDIUM", assigneeEmail: p, dueDate: null, createdByEmail: O.owner, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deletedAt: null });
  const ownerM = await c.orgMembers.findOne({ orgId: O.orgId, email: O.owner });
  const pv = await previewAccessRemoval({ orgId: O.orgId, email: p, membership: ownerM, actorEmail: O.owner });
  assert.equal(pv.noChangesWereMade, true); assert.equal(pv.businessImpact.directImpact.status, "IMPACT_DETECTED", J(pv.businessImpact));
  assert.ok(pv.businessImpact.directImpact.tasksAffected.some((t) => t.title === "Twin task")); assert.ok(pv.identityImpact.grants.length >= 1 && pv.identityImpact.grants[0].source);
  assert.ok(pv.businessImpact.integrityHash); assert.equal((await mem(O, p)).status, "active");
  assert.ok(await c.orgActivity.findOne({ orgId: O.orgId, recordType: "DIGITAL_TWIN_SIMULATION", "metadata.entityId": p }), "recorded by the Digital Twin's own audit entry");
  assert.ok((await previewAccessRemoval({ orgId: O.orgId, email: "x@nowhere.example", membership: ownerM, actorEmail: O.owner })).error);
});

test("outbound events: signed, queued, delivered, retried, secret-free; only https/allowed hosts (SOW 22, 23, 36)", async () => {
  const got = []; let fail = 1;
  const { s, port } = await listen(async (req, res) => { const raw = await readAll(req); got.push({ raw, headers: req.headers }); if (fail > 0) { fail--; res.statusCode = 500; return res.end("nope"); } res.statusCode = 200; res.end("ok"); });
  try {
    const bad = await createSubscription({ orgId: O.orgId, url: "http://169.254.169.254/latest", events: ["access.revoked"], actorEmail: O.owner }); assert.ok(bad.error, "metadata endpoints are blocked");
    assert.ok((await createSubscription({ orgId: O.orgId, url: `http://127.0.0.1:${port}/hook`, events: ["user.exploded"], actorEmail: O.owner })).error, "unknown event names are refused");
    const sub = await createSubscription({ orgId: O.orgId, url: `http://127.0.0.1:${port}/hook`, events: ["access.revoked", "credential.revoked", "sync.drift_detected", "organization.mapping_changed"], actorEmail: O.owner });
    assert.ok(sub.secret?.startsWith("whsec_"), J(sub));
    const who = await join(O, "outb", ["Inaya-Finance"], 16);
    await revokeAccess({ orgId: O.orgId, email: who, trigger: "test", actor: "test", mode: "full" });
    await createMapping({ orgId: O.orgId, providerId: O.providerId, body: { name: "Outbound test", match: { type: "group", value: "Outbound" }, grants: [{ kind: "role", value: "member" }] }, actorEmail: O.owner });
    const q = await listDeliveries({ orgId: O.orgId }); assert.ok(q.deliveries.length >= 2, J(q.deliveries));
    const r1 = await processDeliveries({ orgId: O.orgId }); assert.ok(r1.failed >= 1, "the first attempt got a 500: retried later, not lost");
    await ic.identityDeliveries.updateMany({ orgId: O.orgId, status: "PENDING" }, { $set: { nextAttemptAt: new Date(Date.now() - 1000).toISOString() } });
    const r2 = await processDeliveries({ orgId: O.orgId }); assert.ok(r1.delivered + r2.delivered >= 2, J([r1, r2]));
    const last = got.find((g) => JSON.parse(g.raw).type === "access.revoked"); assert.ok(last);
    const v = verifySignature({ secret: sub.secret, timestamp: last.headers["x-inaya-timestamp"], signature: last.headers["x-inaya-signature"], rawBody: last.raw }); assert.equal(v.ok, true, "receivers can verify the signature with the same scheme");
    const body = JSON.parse(last.raw); assert.equal(body.version, 1); assert.equal(body.organizationId, O.oid); assert.equal(body.subject.email, who); assert.ok(body.id && body.occurredAt);
    assert.ok(!last.raw.includes(sub.secret) && !/token|secret|password/i.test(last.raw.replace(/"steps"/g, "")), "no secrets in the payload");
  } finally { s.close(); }
});

const scim = async (method, path, { token, body, query = "" } = {}) => {
  const h = { "x-forwarded-for": "203.0.113.9", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/scim+json" } : {}) };
  const res = await scimRoute[method](new NextRequest(`http://localhost/api/scim/v2/${path}${query}`, { method, headers: h, ...(body !== undefined ? { body: J(body) } : {}) }), { params: Promise.resolve({ path: path.split("/") }) });
  const text = await res.text(); return { status: res.status, ct: res.headers.get("content-type"), json: text ? JSON.parse(text) : null };
};

test("SCIM 2.0: users and groups go through the same engine; deactivate not delete; groups map through mappings; tenants stay separate (SOW 19)", async () => {
  await createMapping({ orgId: S.orgId, providerId: S.providerId, body: { name: "Finance", match: { type: "group", value: "Inaya-Finance" }, grants: [{ kind: "department", value: "dept:Finance" }] }, actorEmail: S.owner });
  const cred = await createCredential({ orgId: S.orgId, label: "entra-scim", scopes: ["identity:scim"], providerId: S.providerId, actorEmail: S.owner });
  const wrong = await createCredential({ orgId: S.orgId, label: "read", scopes: ["identity:read"], actorEmail: S.owner });
  const credB = await createCredential({ orgId: SB.orgId, label: "b-scim", scopes: ["identity:scim"], providerId: SB.providerId, actorEmail: SB.owner });
  assert.equal((await scim("GET", "Users")).status, 401); assert.equal((await scim("GET", "Users", { token: wrong.token })).status, 403, "wrong scope");
  const cfg = await scim("GET", "ServiceProviderConfig", { token: cred.token }); assert.equal(cfg.status, 200); assert.equal(cfg.json.bulk.supported, false); assert.match(cfg.ct, /scim\+json/);
  assert.equal((await scim("GET", "Schemas", { token: cred.token })).json.totalResults, 3); assert.equal((await scim("GET", "ResourceTypes", { token: cred.token })).status, 200);
  const email = mail("scim-u1");
  const created = await scim("POST", "Users", { token: cred.token, body: { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName: email, externalId: `scim-ext-${RUN}-1`, displayName: "Sam SCIM", emails: [{ value: email, primary: true }], active: true } });
  assert.equal(created.status, 201, J(created.json)); assert.equal(created.json.active, true); const id = created.json.id;
  assert.equal((await mem(S, email)).status, "active", "a SCIM create is a joiner");
  assert.equal((await scim("POST", "Users", { token: cred.token, body: { userName: email, externalId: `scim-ext-${RUN}-1` } })).status, 409, "uniqueness");
  assert.equal((await scim("POST", "Users", { token: cred.token, body: { externalId: "x" } })).status, 400);
  const byName = await scim("GET", "Users", { token: cred.token, query: `?filter=${encodeURIComponent(`userName eq "${email}"`)}` }); assert.equal(byName.json.totalResults, 1);
  assert.equal((await scim("GET", "Users", { token: cred.token, query: `?filter=${encodeURIComponent("userName co \"x\"")}` })).json.scimType, "invalidFilter");
  const grp = await scim("POST", "Groups", { token: cred.token, body: { displayName: "Inaya-Finance", members: [{ value: id }] } }); assert.equal(grp.status, 201, J(grp.json));
  assert.deepEqual((await mem(S, email)).departmentIds.map(String), [String(S.finance)], "the group->department mapping applied");
  const gl = await scim("GET", "Groups", { token: cred.token }); assert.equal(gl.json.totalResults, 1);
  assert.equal((await scim("PATCH", `Groups/${grp.json.id}`, { token: cred.token, body: { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "remove", path: `members[value eq "${id}"]` }] } })).status, 200);
  assert.deepEqual((await mem(S, email)).departmentIds.map(String), [], "leaving the group removes the mapped access");
  // cross-tenant: organization B's SCIM credential cannot see or change A's users
  assert.equal((await scim("GET", `Users/${id}`, { token: credB.token })).status, 404);
  assert.equal((await scim("PATCH", `Users/${id}`, { token: credB.token, body: { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "replace", path: "active", value: false }] } })).status, 404);
  assert.equal((await scim("GET", "Users", { token: credB.token })).json.totalResults, 0);
  // deactivate through PATCH = leaver; the member is frozen and verified
  const off = await scim("PATCH", `Users/${id}`, { token: cred.token, body: { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "replace", path: "active", value: false }] } });
  assert.equal(off.status, 200, J(off.json)); assert.equal(off.json.active, false); assert.equal((await mem(S, email)).status, "revoked");
  // re-enable does not silently resurrect access (restoreOnEnable defaults to manual review)
  const on = await scim("PATCH", `Users/${id}`, { token: cred.token, body: { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "replace", path: "active", value: true }] } });
  assert.equal(on.status, 200); assert.equal((await mem(S, email)).status, "revoked", "still revoked: a person must approve the restore");
  assert.equal((await scim("PATCH", `Users/${id}`, { token: cred.token, body: { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "replace", path: "externalId", value: "swap" }] } })).json.scimType, "mutability", "externalId is immutable");
  // DELETE deactivates and keeps the record
  const email2 = mail("scim-u2"); const u2 = await scim("POST", "Users", { token: cred.token, body: { userName: email2, externalId: `scim-ext-${RUN}-2`, emails: [{ value: email2, primary: true }] } });
  const del = await scim("DELETE", `Users/${u2.json.id}`, { token: cred.token }); assert.equal(del.status, 204);
  assert.equal((await mem(S, email2)).status, "revoked"); assert.equal((await scim("GET", `Users/${u2.json.id}`, { token: cred.token })).json.active, false, "the record still exists");
  assert.equal((await scim("GET", "Bogus", { token: cred.token })).status, 404);
});

test("Microsoft Graph pull against a stand-in for Microsoft: token, paging, groups; the client secret is stored encrypted and never returned (SOW 10)", async () => {
  const seen = [];
  const { s, port } = await listen(async (req, res) => {
    const raw = await readAll(req); seen.push({ url: req.url, auth: req.headers.authorization || null, raw });
    res.setHeader("content-type", "application/json");
    if (req.url.includes("/oauth2/v2.0/token")) { const p = new URLSearchParams(raw); if (p.get("client_secret") !== "graph-secret-value") { res.statusCode = 401; return res.end(J({ error: "invalid_client" })); } return res.end(J({ access_token: "tok-1", expires_in: 3600 })); }
    if (req.headers.authorization !== "Bearer tok-1") { res.statusCode = 401; return res.end("{}"); }
    if (req.url.startsWith("/v1.0/users") && !req.url.includes("page2")) return res.end(J({ value: [{ id: "obj-gr-a", userPrincipalName: mail("gr-a"), mail: mail("gr-a"), accountEnabled: true, displayName: "Gina A" }, { id: "obj-gr-b", userPrincipalName: mail("gr-b"), mail: mail("gr-b"), accountEnabled: false, displayName: "Gus B" }], "@odata.nextLink": `http://127.0.0.1:${port}/v1.0/users?page2=1` }));
    if (req.url.startsWith("/v1.0/users")) return res.end(J({ value: [{ id: "obj-gr-c", userPrincipalName: mail("gr-c"), mail: mail("gr-c"), accountEnabled: true }] }));
    if (req.url.startsWith("/v1.0/groups/grp-fin/members")) return res.end(J({ value: [{ id: "obj-gr-a" }] }));
    if (req.url.startsWith("/v1.0/groups/grp-fin")) return res.end(J({ displayName: "Inaya-Finance" }));
    res.statusCode = 404; res.end("{}");
  });
  process.env.GRAPH_LOGIN_BASE_URL = `http://127.0.0.1:${port}`; process.env.GRAPH_BASE_URL = `http://127.0.0.1:${port}`;
  try {
    const a = await join(O, "gr-a", ["Inaya-Finance"], 20); const b = await join(O, "gr-b", ["Inaya-Finance"], 21); void a; void b;
    const r = await updateProvider({ orgId: O.orgId, providerId: O.providerId, patch: { graph: { clientId: "app-1", tenantId: "graph-tenant-1", clientSecret: "graph-secret-value", groupIds: ["grp-fin"] } }, actorEmail: O.owner });
    assert.ok(!J(r).includes("graph-secret-value"), "the secret is not returned"); assert.ok(!J(providerView(await getProviderById(O.providerId))).includes("graph-secret-value"));
    const stored = await ic.identityProviders.findOne({ _id: O.provider._id }); assert.ok(stored.graph.clientSecretEncrypted && !stored.graph.clientSecretEncrypted.includes("graph-secret"), "stored encrypted");
    const out = await pullAndReconcile({ provider: await getProviderById(O.providerId), actor: O.owner });
    assert.equal(out.report.directoryUsers, 3, "both pages were read"); assert.equal(out.report.source, "graph_pull");
    const kinds = out.report.findings.map((f) => `${f.kind}:${f.email}`);
    assert.ok(kinds.includes(`DISABLED_STILL_ACTIVE:${mail("gr-b")}`), J(kinds)); assert.ok(kinds.includes(`MISSING_IN_INAYA:${mail("gr-c")}`));
    assert.ok(seen.some((x) => x.url.includes("grp-fin/members")), "group membership was read for the mapped group");
    await updateProvider({ orgId: O.orgId, providerId: O.providerId, patch: { graph: { clientId: "app-1", tenantId: "graph-tenant-1", clientSecret: "wrong" } }, actorEmail: O.owner });
    await assert.rejects(pullAndReconcile({ provider: await getProviderById(O.providerId) }), /refused|permissions|token/i, "a bad secret surfaces as an authentication problem, not silence");
  } finally { s.close(); delete process.env.GRAPH_LOGIN_BASE_URL; delete process.env.GRAPH_BASE_URL; }
});

test("worker: an unfinished revocation is retried with backoff until every step is verified; metrics come from real rows (SOW 15, 47, 49)", async () => {
  const who = await join(O, "wk", ["Inaya-Finance"], 30);
  __setRevocationFault("CREDENTIALS", 1);
  const first = await revokeAccess({ orgId: O.orgId, email: who, trigger: "test", actor: "test", mode: "full" });
  assert.equal(first.revocation.state, "REVOCATION_PARTIAL"); assert.equal((await mem(O, who)).status, "revoked", "frozen even while partial");
  const early = await runIdentityWorker({ orgId: O.oid, now: Date.now() }); assert.equal(early.revocations.completed, 0, "too soon: backoff not elapsed");
  const later = await runIdentityWorker({ orgId: O.oid, now: Date.now() + 3 * 3600000 });
  assert.ok(later.revocations.completed >= 1, J(later));
  const rev = await ic.identityRevocations.findOne({ orgId: O.orgId, email: who }, { sort: { createdAt: -1 } }); assert.equal(rev.state, "REVOCATION_COMPLETE"); assert.equal(rev.attempts, 2);
  const m = await identityMetrics({ orgId: O.orgId, windowDays: 30 });
  assert.ok(m.revocation.complete >= 1 && m.lifecycle.total >= 1 && m.source === "computed from durable rows only"); assert.ok(m.providers.length === 1);
  const empty = await identityMetrics({ orgId: SB.orgId, windowDays: 30 }); assert.equal(empty.lifecycle.total, 0, "another organization's numbers are its own: no fabricated data");
  __setRevocationFault(null);
  void createProvider; void signedHeaders; void reconcileSubjects;
});
