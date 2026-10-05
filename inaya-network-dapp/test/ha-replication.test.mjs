// test/ha-replication.test.mjs -- site replication and failover readiness (HA-001): profile rules, MEASURED state from real replica records, recovery tests that really read
// replicas back and verify their hash, honest blockers, alerts, evidence package. Real MongoDB; storage providers are in-memory stand-ins for the network boundary only.
// Run: node --env-file=.env.local --import ./test/_next-loader.mjs --test --test-force-exit --test-timeout=300000 test/ha-replication.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { setup, teardown, makeChatOrg, c as cols } from "./_chat-fixtures.mjs";
import { getOrgCollections } from "../src/lib/orgs.js";
import clientPromise from "../src/lib/mongodb.js";
import * as H from "../src/lib/ha/replication.js";

const T = { timeout: 300000 };
const code = (p) => p.then(() => null, (e) => e);
const sha = (s) => createHash("sha256").update(s).digest("hex");
const RUN = randomBytes(3).toString("hex");
let org, other, owner, member, db, reps, docs;
const store = new Map(); const down = new Set();
const providers = (name) => ({ fetchReplica: async (ref) => { if (down.has(name)) throw new Error("outage"); if (!store.has(ref)) throw new Error("replica not found"); return store.get(ref); } });
const MIN = 60_000;

const addDoc = async (i, ageMin) => { const hash = `0xha-${RUN}-${i}`; const created = new Date(Date.now() - ageMin * MIN).toISOString(); await cols.orgDocuments.insertOne({ orgId: org.orgId, departmentId: new ObjectId(), projectId: new ObjectId(), filename: `f${i}.pdf`, fileHash: hash, sizeBytes: 10, uploadedByEmail: owner.email, status: "DRAFT", accessLevel: "PRIVATE", createdAt: created, deletedAt: null }); return hash; };
const addReplica = async (fileHash, provider, { content = `ciphertext-${fileHash}`, hashOf = null, ok = true, corrupted = false, checkedMinAgo = 5, shardId = "alpha" } = {}) => {
  const ref = `ref-${provider}-${fileHash}-${shardId}`; store.set(ref, content);
  await reps.updateOne({ fileHash, shardId, provider }, { $set: { fileHash, shardId, provider, cid: `cid-${ref}`, providerRef: ref, contentHash: hashOf ?? sha(content), lastCheckedAt: new Date(Date.now() - checkedMinAgo * MIN), lastCheckOk: ok, consecutiveFailures: ok ? 0 : 5, corrupted }, $setOnInsert: { pinnedAt: new Date() } }, { upsert: true });
};

before(async () => {
  await setup(); db = (await getOrgCollections()).db; reps = (await clientPromise).db("inaya_network").collection("backup_replicas");
  org = await makeChatOrg("ha", { people: ["member"] }); other = await makeChatOrg("hb", { people: [] }); owner = org.owner; member = org.member;
  docs = []; for (let i = 0; i < 4; i++) docs.push(await addDoc(i, [600, 300, 120, 30][i]));
});
after(async () => { await reps.deleteMany({ fileHash: { $regex: `^0xha-${RUN}` } }).catch(() => {}); for (const n of ["ha_profiles", "ha_recovery_tests", "notifications"]) await db.collection(n).deleteMany({ orgId: { $in: [org.orgId, other.orgId] } }).catch(() => {}); await cols.orgDocuments.deleteMany({ orgId: org.orgId }); await teardown(); });

test("profile: only providers that exist, different primary and secondaries, sane targets; admins only; active-passive is stated", T, async () => {
  const base = { orgId: org.oid, membership: owner.membership, actorEmail: owner.email };
  assert.equal((await code(H.setProfile({ ...base, membership: member.membership, primary: "pinata", secondaries: ["filebase"] })))?.status, 403);
  for (const bad of [{ primary: "nope", secondaries: ["filebase"] }, { primary: "pinata", secondaries: [] }, { primary: "pinata", secondaries: ["pinata"] }, { primary: "pinata", secondaries: ["filebase"], targets: { rtoMinutes: 0 } }, { primary: "pinata", secondaries: ["filebase", "local", "x", "y"] }]) assert.equal((await code(H.setProfile({ ...base, ...bad })))?.status, 400, JSON.stringify(bad));
  const r = await H.setProfile({ ...base, primary: "pinata", secondaries: ["filebase"], targets: { rtoMinutes: 120, rpoMinutes: 240 } });
  assert.equal(r.profile.mode, "active_passive"); assert.match(r.note, /Active-active operation is not provided/); assert.deepEqual(r.profile.targets, { rtoMinutes: 120, rpoMinutes: 240 });
  assert.equal((await code(H.getProfile({ orgId: org.oid, membership: member.membership })))?.status, 403);
  assert.equal((await H.measure({ orgId: other.oid, membership: other.owner.membership })).configured, false, "another organization has no profile of its own");
});

test("summarizeSite (pure): every state, with the lag measured from the oldest unreplicated file", T, () => {
  const now = Date.now(); const f = (o) => ({ createdAt: new Date(now - 10 * MIN).toISOString(), hasPrimary: true, hasSecondary: true, corrupted: false, disagrees: false, checkedAt: new Date(now - MIN).toISOString(), ...o });
  assert.equal(H.summarizeSite({ files: [], rpoTargetMinutes: 60, now }).state, "NO_DATA");
  assert.equal(H.summarizeSite({ files: [f(), f()], rpoTargetMinutes: 60, now }).state, "SYNCED");
  const lag = H.summarizeSite({ files: [f(), f({ hasSecondary: false, createdAt: new Date(now - 30 * MIN).toISOString() })], rpoTargetMinutes: 60, now }); assert.equal(lag.state, "LAGGING"); assert.equal(lag.lagMinutes, 30); assert.equal(lag.missing, 1);
  assert.equal(H.summarizeSite({ files: [f({ hasSecondary: false, createdAt: new Date(now - 90 * MIN).toISOString() })], rpoTargetMinutes: 60, now }).state, "BEHIND_TARGET");
  assert.equal(H.summarizeSite({ files: [f({ checkedAt: new Date(now - 30 * 3600_000).toISOString() })], rpoTargetMinutes: 60, now }).state, "STALE");
  assert.equal(H.summarizeSite({ files: [f({ disagrees: true })], rpoTargetMinutes: 60, now }).state, "CONFLICT"); assert.equal(H.summarizeSite({ files: [f({ corrupted: true })], rpoTargetMinutes: 60, now }).state, "ERROR");
});

test("measured state from real replica records: lag, backlog, RPO exposure against the target, conflicts and corruption", T, async () => {
  const m = () => H.measure({ orgId: org.oid, membership: owner.membership });
  assert.equal((await m()).sites[0].state, "NO_DATA", "nothing replicated yet is reported as NO_DATA, not as healthy");
  for (const h of docs) await addReplica(h, "pinata");
  await addReplica(docs[2], "filebase"); await addReplica(docs[3], "filebase");
  let s = (await m()).sites[0]; assert.equal(s.total, 4); assert.equal(s.covered, 2); assert.equal(s.missing, 2); assert.ok(s.lagMinutes >= 599 && s.lagMinutes <= 602, `oldest missing file is 600 minutes old, got ${s.lagMinutes}`); assert.equal(s.state, "BEHIND_TARGET", "600 minutes is beyond the 240 minute target");
  let r = await m(); assert.equal(r.measured.rpoWithinTarget, false); assert.ok(r.failoverReadiness.ready === false);
  await addReplica(docs[0], "filebase"); await addReplica(docs[1], "filebase"); s = (await m()).sites[0]; assert.equal(s.state, "SYNCED"); assert.equal(s.lagMinutes, 0); assert.equal((await m()).measured.rpoWithinTarget, true);
  await addReplica(docs[1], "filebase", { checkedMinAgo: 3000 }); assert.equal((await m()).sites[0].state, "STALE");
  await addReplica(docs[1], "filebase", { hashOf: "f".repeat(64) }); assert.equal((await m()).sites[0].state, "CONFLICT", "the two sites disagree on a file's hash");
  await addReplica(docs[1], "filebase"); await reps.updateOne({ fileHash: docs[1], provider: "filebase" }, { $set: { corrupted: true } }); assert.equal((await m()).sites[0].state, "ERROR");
  await addReplica(docs[1], "filebase"); assert.equal((await m()).sites[0].state, "SYNCED", "repairing the replica clears it");
  await reps.updateOne({ fileHash: docs[0], provider: "pinata" }, { $set: { lastCheckOk: false, consecutiveFailures: 9 } }); const lost = (await m()).sites[0]; assert.equal(lost.missing, 0, "a file with no healthy primary is not counted as 'missing at the secondary'");
  await addReplica(docs[0], "pinata");
});

test("recovery test: reads a sample back from the secondary and verifies each file; the RTO is labelled sample-only; failure is detected, recorded and alerted", T, async () => {
  const base = { orgId: org.oid, membership: owner.membership, actorEmail: owner.email, getProviderFn: providers };
  assert.equal((await code(H.runRecoveryTest({ ...base, membership: member.membership, secondary: "filebase" })))?.status, 403);
  assert.equal((await code(H.runRecoveryTest({ ...base, secondary: "local" })))?.status, 400, "not a secondary in the profile");
  const ok = await H.runRecoveryTest({ ...base, secondary: "filebase", sample: 3 }); assert.equal(ok.result, "PASS"); assert.equal(ok.sampled, 3); assert.equal(ok.verified, 3); assert.equal(ok.rto.basis, "SAMPLE_ONLY"); assert.match(ok.rto.note, /not a measured full-site recovery time/); assert.ok(ok.measuredSeconds >= 0);
  const capped = await H.runRecoveryTest({ ...base, secondary: "filebase", sample: 9999 }); assert.ok(capped.sampled <= H.TEST_SAMPLE_MAX * 2);
  store.set(`ref-filebase-${docs[2]}-alpha`, "tampered"); const bad = await H.runRecoveryTest({ ...base, secondary: "filebase", sample: 10 }); assert.equal(bad.result, "FAIL"); assert.ok(bad.failures.some((f) => f.reason === "content hash mismatch" && f.fileHash === docs[2]));
  store.set(`ref-filebase-${docs[2]}-alpha`, `ciphertext-${docs[2]}`); down.add("filebase"); const out = await H.runRecoveryTest({ ...base, secondary: "filebase", sample: 2 }); assert.equal(out.result, "FAIL"); assert.ok(out.failures.every((f) => f.reason === "outage")); down.delete("filebase");
  const note = await db.collection("notifications").countDocuments({ orgId: org.orgId, type: "resilience.failed" }); assert.ok(note >= 1, "an operator alert was raised for the failed test");
  const log = await cols.orgActivity.find({ orgId: org.orgId, recordType: "HA_RECOVERY_TEST" }).toArray(); assert.ok(log.some((e) => e.action === "PASSED") && log.some((e) => e.action === "FAILED"), "every test is in the audit chain");
  const m = await H.measure({ orgId: org.oid, membership: owner.membership }); assert.ok(m.recentTests.length >= 3); assert.ok(m.failoverReadiness.blockers.some((b) => b.code === "LAST_TEST_FAILED"), "the latest failed test blocks readiness");
});

test("failover readiness: blockers are named; it becomes ready only when replicas are in sync AND a recovery test has passed; it never claims to switch anything", T, async () => {
  const base = { orgId: org.oid, membership: owner.membership, actorEmail: owner.email, getProviderFn: providers };
  const pass = await H.runRecoveryTest({ ...base, secondary: "filebase", sample: 4 }); assert.equal(pass.result, "PASS");
  const m = await H.measure({ orgId: org.oid, membership: owner.membership }); assert.equal(m.failoverReadiness.ready, true, JSON.stringify(m.failoverReadiness.blockers)); assert.ok(m.lastVerifiedRestoreAt); assert.match(m.failoverReadiness.note, /manual procedure/);
  await H.setProfile({ orgId: org.oid, membership: owner.membership, actorEmail: owner.email, primary: "pinata", secondaries: ["filebase", "local"], targets: { rtoMinutes: 120, rpoMinutes: 240 } });
  const two = await H.measure({ orgId: org.oid, membership: owner.membership }); assert.ok(two.failoverReadiness.blockers.some((b) => b.site === "local" && b.code === "NEVER_TESTED"), "a second secondary that was never tested blocks readiness"); assert.equal(two.failoverReadiness.ready, false);
  await H.setProfile({ orgId: org.oid, membership: owner.membership, actorEmail: owner.email, primary: "pinata", secondaries: ["filebase"], targets: { rtoMinutes: 120, rpoMinutes: 240 } });
});

test("alerts: a secondary behind its RPO target alerts an operator once per day", T, async () => {
  await reps.deleteMany({ fileHash: docs[0], provider: "filebase" }); const before = await db.collection("notifications").countDocuments({ orgId: org.orgId, type: "resilience.failed" });
  const a = await H.checkAndAlert({ orgId: org.oid }); assert.equal(a.alerted, 1); const mid = await db.collection("notifications").countDocuments({ orgId: org.orgId, type: "resilience.failed" }); assert.ok(mid > before);
  await H.checkAndAlert({ orgId: org.oid }); assert.equal(await db.collection("notifications").countDocuments({ orgId: org.orgId, type: "resilience.failed" }), mid, "the same alert is not repeated the same day");
  await addReplica(docs[0], "filebase"); assert.equal((await H.checkAndAlert({ orgId: org.oid })).alerted, 0, "no alert when in sync");
});

test("evidence package: self-describing, hashed, honest about what it does not show, exportable only by administrators and auditors", T, async () => {
  assert.equal((await code(H.evidencePackage({ orgId: org.oid, membership: member.membership, actorEmail: member.email })))?.status, 403);
  const p = await H.evidencePackage({ orgId: org.oid, membership: owner.membership, actorEmail: owner.email }); const { sha256, ...body } = p;
  assert.equal(sha256, createHash("sha256").update(JSON.stringify(body)).digest("hex"), "the hash covers the whole package"); assert.equal(p.kind, "inaya.ha-replication-evidence"); assert.equal(p.profile.mode, "active_passive");
  assert.ok(p.statements.some((s) => /No active-active/.test(s)) && p.statements.some((s) => /not a full-site recovery time/.test(s)) && p.statements.some((s) => /does not show a completed failover/.test(s)));
  assert.ok(p.measured.recentTests.length >= 1); assert.equal(JSON.stringify(p).includes("ciphertext-"), false, "no replica content in the package");
  const auditor = { ...member, membership: { ...member.membership, adminRoles: ["auditor"] } }; assert.ok((await H.evidencePackage({ orgId: org.oid, membership: auditor.membership, actorEmail: member.email })).sha256, "an auditor may export");
});
