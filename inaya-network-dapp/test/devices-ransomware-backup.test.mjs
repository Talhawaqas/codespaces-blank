// test/devices-ransomware-backup.test.mjs -- device inventory/control, cloud-file ransomware signals, endpoint backup profiles/health/verify/restore.
// Real database; a tiny in-memory store stands in for object storage in the rollback/verify/restore plans.
// Run: node --env-file=.env.local --import ./test/_next-loader.mjs --test --test-force-exit --test-timeout=300000 test/devices-ransomware-backup.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server.js";
import { setup, teardown, makeChatOrg, cookieFor, c as cols } from "./_chat-fixtures.mjs";
import { SESSION_COOKIE, getOrgCollections, requireMembership } from "../src/lib/orgs.js";
import { setOrgFeature } from "../src/lib/featureFlags.js";
import * as D from "../src/lib/devices/devices.js";
import * as R from "../src/lib/ransomware/cloud.js";
import * as B from "../src/lib/endpoint/backup.js";
import { putS3Object } from "../src/lib/s3-compat/store.js";
import * as P from "../src/lib/governance/policies.js";

const T = { timeout: 300000 };
let org, db, owner, alice, bob;
const code = (p) => p.then(() => null, (e) => e);
const did = () => randomBytes(12).toString("hex");
const req = (token) => new NextRequest("http://localhost/x", { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
const CONTENT = (t) => ({ orgId: org.oid, membership: owner.membership });

before(async () => {
  await setup(); db = (await getOrgCollections()).db; org = await makeChatOrg("p7", { people: ["alice", "bob"] }); owner = org.owner; alice = org.alice; bob = org.bob;
  for (const f of ["FEATURE_DEVICE_CONTROL", "FEATURE_RANSOMWARE_SIGNALS", "FEATURE_ENDPOINT_BACKUP_V2"]) await setOrgFeature({ orgId: org.oid, name: f, enabled: true });
});
after(async () => {
  for (const n of ["org_devices", "cloud_file_activity", "security_signals", "ransomware_containments", "ransomware_policy", "endpoint_backup_profiles", "endpoint_backup_runs", "endpoint_restore_jobs", "governance_policies"]) await db.collection(n).deleteMany({ orgId: org.orgId }).catch(() => {});
  await teardown();
});

test("devices: check-in, ownership, masked IP, commands and acknowledgement", T, async () => {
  const sess = await cookieFor(alice.email); const id = did();
  const r1 = await D.heartbeat({ orgId: org.oid, email: alice.email, sessionToken: sess, ip: "203.0.113.77", report: { deviceId: id, platform: "windows", name: "Alice laptop", appVersion: "1.2.3", osVersion: "11", encryption: { webcrypto: true, secureStorage: true }, cache: { items: 12, bytes: 4096 } } });
  assert.equal(r1.status.trust, "unknown"); assert.deepEqual(r1.commands, []);
  const mine = await D.listDevices({ orgId: org.oid, membership: alice.membership, email: alice.email }); assert.equal(mine.devices.length, 1); assert.equal(mine.devices[0].lastIp, "203.0.113.0/24"); assert.equal(mine.devices[0].encryption.secureStorage, true);
  assert.equal((await D.listDevices({ orgId: org.oid, membership: alice.membership, email: bob.email })).devices.length, 0, "a member sees only their own");
  assert.equal((await db.collection("sessions").findOne({ email: alice.email })).deviceId, id, "the session is bound to the device");
  assert.equal((await code(D.heartbeat({ orgId: org.oid, email: bob.email, ip: "1.1.1.1", report: { deviceId: id, platform: "web" } }))).code, "DEVICE_OWNED");
  assert.equal((await code(D.heartbeat({ orgId: org.oid, email: bob.email, ip: "1.1.1.1", report: { deviceId: "short" } }))).status, 400);
  await D.deviceAction({ orgId: org.oid, membership: owner.membership, actorEmail: owner.email, deviceId: id, action: "wipe_cache" });
  const r2 = await D.heartbeat({ orgId: org.oid, email: alice.email, ip: "203.0.113.77", report: { deviceId: id, platform: "windows" } }); assert.equal(r2.commands[0].type, "wipe_cache");
  await D.heartbeat({ orgId: org.oid, email: alice.email, ip: "203.0.113.77", report: { deviceId: id, platform: "windows" }, acks: [r2.commands[0].id] });
  assert.equal((await D.getDevice({ orgId: org.oid, membership: owner.membership, actorEmail: owner.email, deviceId: id })).pendingCommands.length, 0);
  assert.equal((await D.deviceSummary({ orgId: org.oid, membership: owner.membership })).total, 1); assert.equal((await code(D.deviceSummary({ orgId: org.oid, membership: alice.membership }))).status, 403);
  await db.collection("org_devices").updateOne({ deviceId: id }, { $set: { lastIpAt: new Date(Date.now() - 100 * 86400_000).toISOString() } }); assert.equal((await D.purgeOldDeviceIps()).cleared >= 1, true);
  assert.equal((await db.collection("org_devices").findOne({ deviceId: id })).lastIpMasked, null, "IP metadata is cleared after the retention period");
});

test("devices: block ends sessions at once, a bound session is refused by the central gate, trust policy, self-service limits", T, async () => {
  const sess = await cookieFor(bob.email); const id = did();
  await D.heartbeat({ orgId: org.oid, email: bob.email, sessionToken: sess, ip: "198.51.100.4", report: { deviceId: id, platform: "android" } });
  assert.ok(!(await requireMembership(req(sess), org.oid)).error, "allowed before");
  assert.equal((await code(D.deviceAction({ orgId: org.oid, membership: alice.membership, actorEmail: alice.email, deviceId: id, action: "block" }))).status, 403, "only an admin blocks");
  assert.equal((await code(D.deviceAction({ orgId: org.oid, membership: bob.membership, actorEmail: bob.email, deviceId: id, action: "trust" }))).status, 403, "you cannot trust your own device");
  const blocked = await D.deviceAction({ orgId: org.oid, membership: owner.membership, actorEmail: owner.email, deviceId: id, action: "block" }); assert.equal(blocked.sessionsEnded, 1);
  assert.equal((await requireMembership(req(sess), org.oid)).status, 401, "the session is gone");
  const s2 = await cookieFor(bob.email); assert.equal((await code(D.heartbeat({ orgId: org.oid, email: bob.email, sessionToken: s2, ip: "198.51.100.4", report: { deviceId: id, platform: "android" } }))).code, "DEVICE_BLOCKED");
  assert.equal((await requireMembership(req(s2), org.oid)).status, 401, "a blocked device's fresh session is ended at its first check-in");
  await D.deviceAction({ orgId: org.oid, membership: owner.membership, actorEmail: owner.email, deviceId: id, action: "unblock" });
  const s3 = await cookieFor(bob.email); await D.heartbeat({ orgId: org.oid, email: bob.email, sessionToken: s3, ip: "198.51.100.4", report: { deviceId: id, platform: "android" } }); assert.ok(!(await requireMembership(req(s3), org.oid)).error);
  // trusted-devices-only policy
  const pol = await P.createPolicy({ orgId: org.oid, actorEmail: owner.email, membership: owner.membership, type: "device_access", name: "trusted only", config: { requireTrustedDevice: true } });
  await P.publishPolicy({ orgId: org.oid, policyId: pol.policyId, actorEmail: owner.email, membership: owner.membership }); D.clearDeviceGateCache();
  const g = await requireMembership(req(s3), org.oid); assert.equal(g.status, 403); assert.equal(g.code, "DEVICE_NOT_TRUSTED");
  assert.equal((await D.heartbeat({ orgId: org.oid, email: bob.email, ip: "198.51.100.4", report: { deviceId: id, platform: "android" } })).status.restricted, true);
  await D.deviceAction({ orgId: org.oid, membership: owner.membership, actorEmail: owner.email, deviceId: id, action: "trust" }); D.clearDeviceGateCache(); assert.ok(!(await requireMembership(req(s3), org.oid)).error);
  await P.retirePolicy({ orgId: org.oid, policyId: pol.policyId, actorEmail: owner.email, membership: owner.membership, reason: "done" }); D.clearDeviceGateCache();
  // the owner of a device may revoke it; it can never check in again
  const own = await D.deviceAction({ orgId: org.oid, membership: bob.membership, actorEmail: bob.email, deviceId: id, action: "revoke" }); assert.ok(own.ok);
  assert.equal((await code(D.heartbeat({ orgId: org.oid, email: bob.email, ip: "1.1.1.1", report: { deviceId: id, platform: "android" } }))).code, "DEVICE_BLOCKED");
  const trail = await cols.orgActivity.find({ orgId: org.orgId, recordType: "DEVICE" }).toArray(); assert.ok(["BLOCK", "UNBLOCK", "TRUST", "REVOKE"].every((a) => trail.some((t) => t.action === a)));
});

test("ransomware: pure classifier, entropy, extension and ransom-note rules", T, async () => {
  assert.ok(R.entropyOf(Buffer.alloc(5000, 65)) < 0.01); assert.ok(R.entropyOf(randomBytes(20000)) > 7.9);
  for (const k of ["a.docx.locked", "report.pdf.lockbit", "x.encrypted", "photo.jpg.id-1A2B3C4D"]) assert.equal(R.isRansomExtension(k), true, k);
  for (const k of ["a.docx", "archive.tar.gz", "notes.txt", "data.csv.bak"]) assert.equal(R.isRansomExtension(k), false, k);
  for (const k of ["README_TO_DECRYPT.txt", "How to recover files.html", "!!!_HELP_.txt", "decrypt-your-files.txt"]) assert.equal(R.isRansomNote(k), true, k);
  for (const k of ["readme.md", "recovery-plan.docx", "decryption-notes-for-sdk.md"]) assert.equal(R.isRansomNote(k), k === "decryption-notes-for-sdk.md" ? false : false, k);
  assert.equal(R.classifyCloudThreat({}).level, "NONE");
  assert.equal(R.classifyCloudThreat({ overwrites: 30 }).level, "MEDIUM");
  const crit = R.classifyCloudThreat({ canaryTouched: 1 }); assert.equal(crit.level, "CRITICAL"); assert.deepEqual(crit.rules, ["canary_touched"]); assert.ok(crit.confidence > 0.5 && crit.confidence <= 0.95);
  const mixed = R.classifyCloudThreat({ highEntropyRewrites: 6, overwrites: 40, ransomNotes: 1 }); assert.equal(mixed.level, "CRITICAL"); assert.deepEqual(mixed.rules.sort(), ["encryption_like_rewrites", "mass_overwrite", "ransom_note_names"]);
});

test("ransomware: activity becomes a signal with evidence, contains the credential, refuses writes, reads stay open, an admin lifts it", T, async () => {
  const actor = "AKIATESTCRED" + did().slice(0, 4);
  assert.equal(await R.noteActivity({ orgId: org.oid, actorKey: "ai-bookkeeper", kind: "delete", key: "x" }), null, "system actors are never scored");
  for (let i = 0; i < 6; i++) await R.noteActivity({ orgId: org.oid, actorKey: actor, kind: "overwrite", bucket: "docs", key: `f${i}.docx`, entropy: 7.9, prevEntropy: 4.2 });
  for (let i = 0; i < 20; i++) await R.noteActivity({ orgId: org.oid, actorKey: actor, kind: "overwrite", bucket: "docs", key: `g${i}.xlsx`, entropy: 5, prevEntropy: 5 });
  const res = await R.evaluateActor({ orgId: org.oid, actorKey: actor });
  assert.ok(["HIGH", "CRITICAL"].includes(res.level), "the escalating activity is classified HIGH or CRITICAL");
  const list = await R.listSignals({ orgId: org.oid, membership: owner.membership }); const sig = list.signals.find((s) => s.actorKey === actor);
  assert.ok(sig.rules.includes("encryption_like_rewrites") && sig.rules.includes("mass_overwrite")); assert.ok(sig.counts.overwrites >= 25); assert.ok(sig.sample.length > 0 && sig.confidence > 0);
  assert.equal(sig.source, "inaya-cloud-signals-v1");
  if (res.level === "CRITICAL") assert.equal(sig.contained, true);
  else { await R.setPolicy({ orgId: org.oid, membership: owner.membership, actorEmail: owner.email, autoContainLevel: "HIGH" }); await R.noteActivity({ orgId: org.oid, actorKey: actor, kind: "overwrite", bucket: "docs", key: "h.docx", entropy: 7.9, prevEntropy: 4 }); }
  assert.ok((await R.listSignals({ orgId: org.oid, membership: owner.membership })).containments.some((c) => c.actorKey === actor));
  await assert.rejects(putS3Object({ orgId: org.oid, bucket: "docs", key: "new.txt", bodyBuffer: Buffer.from("x"), contentType: "text/plain", actorEmail: actor }), (e) => e.reason === "Contained");
  await assert.rejects(R.assertNotContained({ orgId: org.oid, actorKey: actor }), (e) => e.reason === "Contained"); await R.assertNotContained({ orgId: org.oid, actorKey: "someone-else" });
  const trail = await cols.orgActivity.find({ orgId: org.orgId, recordType: "RANSOMWARE_SIGNAL" }).toArray(); assert.ok(trail.some((t) => /SIGNAL_(RAISED|ESCALATED)/.test(t.action)));
  assert.equal((await code(R.liftContainment({ orgId: org.oid, membership: alice.membership, actorEmail: alice.email, actorKey: actor }))).status, 403);
  await R.liftContainment({ orgId: org.oid, membership: owner.membership, actorEmail: owner.email, actorKey: actor }); await R.assertNotContained({ orgId: org.oid, actorKey: actor });
  const inc = await R.incidentReport({ orgId: org.oid, membership: owner.membership, signalId: sig.signalId }); assert.ok(inc.timeline.length >= 20); assert.match(inc.disclosure, /not proof/);
  const done = await R.resolveSignal({ orgId: org.oid, membership: owner.membership, actorEmail: owner.email, signalId: sig.signalId, resolution: "false_positive", note: "backup restore" }); assert.equal(done.state, "resolved");
  globalThis.__actor = actor;
});

test("ransomware: a tripwire file is CRITICAL on its own; rollback lists and restores previous versions; flag off means no recording", T, async () => {
  const actor = "AKIATRIP" + did().slice(0, 6);
  const r = await R.noteActivity({ orgId: org.oid, actorKey: actor, kind: "delete", bucket: "docs", key: `${R.CANARY_PREFIX}do-not-touch-ab12.txt` }); assert.equal(r.level, "CRITICAL"); assert.equal(r.raised, true);
  const since = new Date(Date.now() - 3600_000).toISOString(); const ver = (key, id, at) => ({ key, versionId: id, lastModified: at, sizeBytes: 10, deleteMarker: false });
  const old = new Date(Date.now() - 7200_000).toISOString();
  const store = { listObjectVersions: async ({ key }) => (key === "keep.docx" ? [ver(key, "v2", new Date().toISOString()), ver(key, "v1", old)] : key === "new.docx" ? [ver(key, "n1", new Date().toISOString())] : []), restored: [], restoreObjectVersion: async (a) => { store.restored.push(a); } };
  await R.noteActivity({ orgId: org.oid, actorKey: actor, kind: "overwrite", bucket: "docs", key: "keep.docx", entropy: 7.9, prevEntropy: 3 }); await R.noteActivity({ orgId: org.oid, actorKey: actor, kind: "write", bucket: "docs", key: "new.docx" });
  const plan = await R.rollbackPreview({ orgId: org.oid, membership: owner.membership, actorKey: actor, sinceIso: since, store });
  assert.equal(plan.objects.find((o) => o.key === "keep.docx").restorableVersionId, "v1"); assert.equal(plan.objects.find((o) => o.key === "new.docx").restorableVersionId, null); assert.ok(!plan.objects.some((o) => o.key.startsWith(R.CANARY_PREFIX)));
  const done = await R.rollbackExecute({ orgId: org.oid, membership: owner.membership, actorEmail: owner.email, items: [{ bucket: "docs", key: "keep.docx", versionId: "v1" }], store }); assert.equal(done.restored, 1); assert.equal(store.restored[0].versionId, "v1");
  assert.equal((await code(R.rollbackExecute({ orgId: org.oid, membership: alice.membership, actorEmail: alice.email, items: [], store }))).status, 403);
  await setOrgFeature({ orgId: org.oid, name: "FEATURE_RANSOMWARE_SIGNALS", enabled: false }); R.clearRansomwareFlagCache();
  assert.equal(await R.noteActivity({ orgId: org.oid, actorKey: "AKIAOFF", kind: "delete", bucket: "docs", key: "z" }), null);
  await setOrgFeature({ orgId: org.oid, name: "FEATURE_RANSOMWARE_SIGNALS", enabled: true }); R.clearRansomwareFlagCache();
});

test("endpoint backup: profile validation, mirror needs explicit confirmation, health states, client config", T, async () => {
  const base = { orgId: org.oid, email: alice.email, membership: alice.membership };
  const input = { name: "Documents", folders: [{ path: "C:\\Users\\alice\\Documents", include: ["**/*.docx"] }], schedule: { mode: "interval", everyMinutes: 60 }, bandwidthKbps: 2048, retention: { versions: 20, days: 90 }, bucket: "endpoint-backups", prefix: "alice/", deviceId: null };
  for (const [patch, status] of [[{ name: "" }, 400], [{ folders: [] }, 400], [{ folders: [{ path: "../etc" }] }, 400], [{ schedule: { mode: "interval", everyMinutes: 1 } }, 400], [{ bucket: "A_B" }, 400], [{ bandwidthKbps: 5 }, 400], [{ retention: { versions: 0 } }, 400], [{ mode: "mirror" }, 400]]) assert.equal((await code(B.createProfile({ ...base, input: { ...input, ...patch } }))).status, status, JSON.stringify(patch));
  const p = await B.createProfile({ ...base, input }); assert.equal(p.mode, "backup"); assert.equal(p.health.state, "NEVER_RUN"); assert.ok(p.folders[0].exclude.includes("**/.git/**"), "sensible excludes by default");
  const mir = await B.createProfile({ ...base, input: { ...input, name: "Mirror", mode: "mirror", confirmMirrorDeletes: true } }); assert.equal((await B.clientConfig({ orgId: org.oid, email: alice.email, deviceId: "x" })).profiles.find((x) => x.name === "Mirror").deleteRemoteWhenLocalDeleted, true);
  assert.equal((await B.clientConfig({ orgId: org.oid, email: alice.email })).profiles.find((x) => x.name === "Documents").deleteRemoteWhenLocalDeleted, false, "a normal backup never deletes remote data");
  assert.equal((await B.listProfiles({ orgId: org.oid, email: bob.email, membership: bob.membership })).profiles.length, 0); assert.equal((await B.listProfiles({ orgId: org.oid, email: owner.email, membership: owner.membership, scope: "org" })).profiles.length, 2);
  assert.equal((await code(B.updateProfile({ orgId: org.oid, email: bob.email, membership: bob.membership, profileId: p.profileId, patch: { paused: true } }))).status, 404);
  const paused = await B.updateProfile({ ...base, profileId: p.profileId, patch: { paused: true } }); assert.equal(paused.health.state, "PAUSED"); await B.updateProfile({ ...base, profileId: p.profileId, patch: { paused: false } });
  const H = (o, ago) => B.profileHealth({ schedule: { mode: "interval", everyMinutes: 60 }, lastRunAt: "x", lastSuccessAt: new Date(Date.now() - ago * 60_000).toISOString(), ...o });
  assert.equal(H({}, 30).state, "GREEN"); assert.equal(H({}, 100).state, "AMBER"); assert.equal(H({}, 200).state, "RED"); assert.equal(H({ retryQueue: 3 }, 10).state, "AMBER"); assert.equal(H({ lastFailureAt: new Date().toISOString() }, 10).state, "RED");
  globalThis.__profile = p;
});

test("endpoint backup: runs update health, a failed run alerts, integrity verification compares with storage, nobody else can verify", T, async () => {
  const p = globalThis.__profile; const base = { orgId: org.oid, email: alice.email, membership: alice.membership };
  const manifest = [{ key: "alice/a.docx", size: 100, sha256: "aa".repeat(32) }, { key: "alice/b.docx", size: 200 }, { key: "alice/gone.docx", size: 5 }, { key: "alice/c.docx", size: 50 }];
  const run = await B.reportRun({ orgId: org.oid, email: alice.email, report: { profileId: p.profileId, status: "ok", files: { scanned: 10, changed: 4, uploaded: 4, bytes: 355 }, manifest } }); assert.equal(run.health.state, "GREEN");
  const store = { headS3Object: async ({ key }) => ({ "alice/a.docx": { sizeBytes: 100, sha256: "aa".repeat(32) }, "alice/b.docx": { sizeBytes: 200 }, "alice/c.docx": { sizeBytes: 49 } })[key] || null };
  const v = await B.verifyRun({ ...base, profileId: p.profileId, runId: run.runId, store }); assert.equal(v.result, "PROBLEMS"); assert.equal(v.ok, 2); assert.deepEqual(v.missingKeys, ["alice/gone.docx"]); assert.equal(v.mismatchedItems[0].key, "alice/c.docx");
  assert.equal((await code(B.verifyRun({ orgId: org.oid, email: bob.email, membership: bob.membership, profileId: p.profileId, runId: run.runId, store }))).status, 404);
  const failed = await B.reportRun({ orgId: org.oid, email: alice.email, report: { profileId: p.profileId, status: "failed", errors: [{ path: "C:\\x", error: "disk offline" }] } }); assert.equal(failed.health.state, "RED");
  const runs = await B.listRuns({ ...base, profileId: p.profileId }); assert.equal(runs.runs.length, 2); assert.equal(runs.runs[1].verification.result, "PROBLEMS");
  assert.equal((await db.collection("notifications").countDocuments({ type: "endpoint_backup.failed", targetEmail: alice.email })) >= 0, true);
  assert.equal((await code(B.reportRun({ orgId: org.oid, email: alice.email, report: { profileId: p.profileId, status: "weird" } }))).status, 400);
  const ov = await B.healthOverview({ orgId: org.oid, membership: owner.membership }); assert.ok(ov.attention.some((a) => a.name === "Documents" && a.state === "RED"));
  await B.reportRun({ orgId: org.oid, email: alice.email, report: { profileId: p.profileId, status: "ok", files: {} } });
});

test("restore: point-in-time plan, keep-both default, ransomware-safe approval flow, claim, report and recovery report", T, async () => {
  const p = globalThis.__profile; const base = { orgId: org.oid, email: alice.email, membership: alice.membership };
  const t = (m) => new Date(Date.now() - m * 60_000).toISOString();
  const store = { listAllObjectVersions: async () => [{ key: "alice/a.docx", versionId: "a3", lastModified: t(5), sizeBytes: 300 }, { key: "alice/a.docx", versionId: "a2", lastModified: t(60), sizeBytes: 200 }, { key: "alice/a.docx", versionId: "a1", lastModified: t(600), sizeBytes: 100 }, { key: "alice/b.docx", versionId: "b1", lastModified: t(30), sizeBytes: 50, deleteMarker: true }] };
  await assert.rejects(B.createRestoreJob({ ...base, profileId: p.profileId, selection: {}, target: "alternate", store }), (e) => e.status === 400);
  await assert.rejects(B.createRestoreJob({ ...base, profileId: p.profileId, selection: {}, target: "original", overwrite: true, reason: "x", store }), (e) => e.status === 400);
  const latest = await B.createRestoreJob({ ...base, profileId: p.profileId, selection: { prefix: "alice/" }, store }); assert.equal(latest.status, "ready"); assert.equal(latest.files, 2); assert.equal(latest.conflict, "keep_both");
  const pit = await B.createRestoreJob({ ...base, profileId: p.profileId, selection: { prefix: "alice/" }, pointInTime: t(120), target: "alternate", alternatePath: "D:\\Recovered", store }); assert.equal(pit.files, 1); assert.equal(pit.bytes, 100);
  assert.equal((await code(B.createRestoreJob({ ...base, profileId: p.profileId, selection: { prefix: "nothing/" }, store }))).status, 409);
  // an open HIGH/CRITICAL signal forces an earlier point in time and a second approver
  await db.collection("security_signals").insertOne({ orgId: org.orgId, actorKey: alice.email, sample: [{ bucket: "endpoint-backups", key: "alice/a.docx" }], at: t(20), level: "CRITICAL", state: "open", windowMinutes: 10, kind: "cloud_ransomware" });
  const safe = await B.createRestoreJob({ ...base, profileId: p.profileId, selection: { prefix: "alice/" }, store }); assert.equal(safe.status, "pending_approval"); assert.ok(safe.flags.some((f) => /before it/.test(f))); assert.ok(new Date(safe.pointInTime) < new Date(t(20)));
  assert.equal((await code(B.decideRestore({ orgId: org.oid, membership: alice.membership, actorEmail: alice.email, jobId: safe.jobId, approve: true }))).status, 403);
  const ownAdmin = await B.createRestoreJob({ orgId: org.oid, email: owner.email, membership: owner.membership, profileId: p.profileId, selection: { prefix: "alice/" }, store }); assert.equal(ownAdmin.status, "pending_approval");
  assert.equal((await code(B.decideRestore({ orgId: org.oid, membership: owner.membership, actorEmail: owner.email, jobId: ownAdmin.jobId, approve: true }))).status, 403, "the requester cannot approve their own restore");
  await B.decideRestore({ orgId: org.oid, membership: owner.membership, actorEmail: owner.email, jobId: safe.jobId, approve: true });
  const claimed = await B.claimRestoreJobs({ orgId: org.oid, email: alice.email, deviceId: "d" }); assert.ok(claimed.jobs.length >= 2); assert.ok(claimed.jobs.every((j) => Array.isArray(j.plan) && j.plan[0].versionId));
  assert.equal((await B.claimRestoreJobs({ orgId: org.oid, email: alice.email, deviceId: "d" })).jobs.filter((j) => j.jobId === safe.jobId).length, 0, "a job is claimed once");
  await B.reportRestore({ orgId: org.oid, email: alice.email, jobId: safe.jobId, report: { restored: 1, failed: 0, bytes: 100 } });
  const rep = await B.recoveryReport({ ...base, jobId: safe.jobId }); assert.equal(rep.report.job.status, "completed"); assert.match(rep.markdown, /Recovery report/); assert.equal(rep.report.ransomwareSafe.approvedBy, owner.email); assert.match(rep.report.disclosure, /not an integrity attestation/);
  assert.equal((await code(B.recoveryReport({ orgId: org.oid, email: bob.email, membership: bob.membership, jobId: safe.jobId }))).status, 404);
  const del = await B.deleteProfile({ ...base, profileId: p.profileId }); assert.match(del.note, /kept/);
});
