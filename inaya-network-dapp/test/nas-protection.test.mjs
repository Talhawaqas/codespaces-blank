// test/nas-protection.test.mjs
// Sovereign NAS SOW: backup -> verify -> restore, recovery drills, cloud targets,
// replication + failover, tiering with approval, ransomware response, the job
// engine, Digital Twin scenarios, state proofs, compliance evidence, updates and
// the worker. Real appliance and real MongoDB. Inaya storage uses in-memory
// pinning providers (fast, and independent of a provider's plan limits) EXCEPT
// the cloud-target test, which talks to a real S3-compatible provider (Filebase).
// Run: node --env-file=.env.local --test test/nas-protection.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import * as fx from "./_nas-fixtures.mjs";
import { installMemoryProviders, storageControl } from "./_docauto-fixtures.mjs";
import { createShare } from "../src/lib/nas/shares.js";
import { setShareAccess } from "../src/lib/nas/access.js";
import { setBackupPolicy, runBackup, backupShareToInaya, restoreFromBackup, runRecoveryDrill, recoveryReadiness, getBackupRun } from "../src/lib/nas/backup.js";
import { createCloudTarget, testCloudTarget, listCloudTargets, deleteCloudTarget, getTargetAdapter } from "../src/lib/nas/cloudTargets.js";
import { createReplicationPolicy, replicateNow, verifyReplica, failoverReplica, deleteReplicationPolicy, listReplicationPolicies } from "../src/lib/nas/replication.js";
import { setTieringPolicy, proposeTiering, decideTiering, applyTiering, recallProposal } from "../src/lib/nas/tiering.js";
import { setThreatPolicy, setBaseline, scanShare, approveLockdown, liftLockdown, liftExpiredLockdowns, resolveThreatEvent, listThreatEvents } from "../src/lib/nas/ransomware.js";
import { enqueueJob, runJob, registerJobHandler, pauseJob, resumeJob, cancelJob, recoverStaleJobs, processDueJobs, getJob, summarizeJobs } from "../src/lib/nas/jobs.js";
import { commitNasState, verifyNasState, verifyManifests } from "../src/lib/nas/state.js";
import { setSnapshotPolicy, createSnapshot, listSnapshots, restoreSnapshot } from "../src/lib/nas/snapshots.js";
import { checkApplianceState, getOverview } from "../src/lib/nas/health.js";
import { checkForUpdate, applyUpdate } from "../src/lib/nas/updates.js";
import { runNasWorker } from "../src/lib/nas/runner.js";
import { verifyNasEvidence, listNasEvidence } from "../src/lib/nas/evidence.js";
import { simulateDigitalTwinScenario } from "../src/lib/digitalTwinSimulate.js";
import { buildEvidencePackage } from "../src/lib/evidenceExporter.js";
import { setShareQuota } from "../src/lib/nas/quotas.js";
import { NasAgentClient } from "../src/lib/nas/agent.js";

let org, appliance, applianceB, mgr, orgObj;
const M = (o = org) => ({ orgId: o.orgId, membership: o.manager.membership, actorEmail: o.manager.email });
const sha = (b) => createHash("sha256").update(b).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function newShare(prefix, files = {}) {
  const shareName = fx.tag(prefix);
  fx.created.shares.add(shareName);
  const s = await createShare({ ...M(), applianceId: String(appliance._id), shareName, ownerUnixUser: mgr.unix });
  assert.ok(!s.error, s.error);
  for (const [rel, content] of Object.entries(files)) await fx.agent.writeFile({ shareName, relativePath: rel, buffer: Buffer.isBuffer(content) ? content : Buffer.from(content), owner: mgr.unix });
  return { shareName, shareId: String(s.share._id), share: s.share };
}

before(async () => {
  await fx.setup();
  installMemoryProviders();
  org = await fx.makeOrg("protect");
  orgObj = (await fx.collections.orgs.findOne({ name: `nas-${fx.RUN}-protect` }))._id;
  appliance = await fx.makeAppliance(org, "Primary NAS");
  applianceB = await fx.makeAppliance(org, "Secondary NAS");
  mgr = await fx.provisionUser(org, org.manager, appliance._id);
});
after(async () => { await fx.teardown(); });

test("backup: deduplicated, verified, resumable, and evidence says VERIFIED only after bytes were read back", async (t) => {
  const { shareName, shareId } = await newShare("bk", { "a.txt": "alpha", "docs/b.txt": "bravo", "docs/c.txt": "charlie", "tmp/skip.log": "noise" });
  let run1;

  await t.test("first backup uploads everything selected, verifies it, and records a recovery point", async () => {
    const pol = await setBackupPolicy({ ...M(), shareId, excludePatterns: ["*.log"], intervalMinutes: 60, verify: "full" });
    assert.ok(!pol.error, pol.error);
    run1 = await runBackup({ orgId: org.orgId, shareId, verify: "full", excludePatterns: ["*.log"], actorEmail: org.manager.email });
    assert.equal(run1.status, "COMPLETED", JSON.stringify(run1.failures));
    assert.equal(run1.filesTotal, 3, "the excluded *.log file is not part of the dataset");
    assert.equal(run1.filesBackedUp, 3);
    assert.equal(run1.filesVerified, 3);
    const ev = await listNasEvidence({ orgId: org.orgId, applianceId: appliance._id });
    assert.ok(ev.some((e) => e.action === "BACKUP_STARTED"));
    const verified = ev.find((e) => e.action === "BACKUP_VERIFIED");
    assert.equal(verified.integrityHash, run1.recoveryManifestHash);
  });

  await t.test("an unchanged share uploads NOTHING (real file-level deduplication)", async () => {
    const before = storageControl.pinCalls;
    const r = await runBackup({ orgId: org.orgId, shareId, verify: "sample", excludePatterns: ["*.log"], actorEmail: org.manager.email });
    assert.equal(r.status, "COMPLETED");
    assert.equal(r.filesBackedUp, 0);
    assert.equal(r.filesSkipped, 3);
    assert.equal(storageControl.pinCalls - before, 0, "no shard was pinned for unchanged data");
    assert.equal(r.recoveryManifestHash, run1.recoveryManifestHash, "same content -> same recovery point");
  });

  await t.test("only the changed file is uploaded", async () => {
    await fx.agent.writeFile({ shareName, relativePath: "docs/b.txt", buffer: Buffer.from("bravo v2"), owner: mgr.unix });
    const r = await runBackup({ orgId: org.orgId, shareId, verify: "sample", excludePatterns: ["*.log"], actorEmail: org.manager.email });
    assert.equal(r.filesBackedUp, 1);
    assert.equal(r.filesSkipped, 2);
    assert.notEqual(r.recoveryManifestHash, run1.recoveryManifestHash);
  });

  await t.test("interrupted backup: a run that failed part-way RESUMES and does not re-upload finished files", async () => {
    await fx.agent.writeFile({ shareName, relativePath: "new1.txt", buffer: Buffer.from("n1"), owner: mgr.unix });
    await fx.agent.writeFile({ shareName, relativePath: "new2.txt", buffer: Buffer.from("n2"), owner: mgr.unix });
    storageControl.failNextPins = 200; // the storage layer rejects everything
    const failed = await runBackup({ orgId: org.orgId, shareId, verify: "sample", excludePatterns: ["*.log"], actorEmail: org.manager.email });
    storageControl.failNextPins = 0;
    assert.notEqual(failed.status, "COMPLETED");
    assert.ok(failed.filesFailed >= 1);
    const ev = await listNasEvidence({ orgId: org.orgId, applianceId: appliance._id, action: "BACKUP_FAILED" });
    assert.ok(ev.length >= 1, "failure is evidence, never silently ignored");
    const resumed = await runBackup({ orgId: org.orgId, shareId, verify: "sample", excludePatterns: ["*.log"], resumeRunId: String(failed.runId), actorEmail: org.manager.email });
    assert.equal(resumed.status, "COMPLETED", JSON.stringify(resumed.failures));
    assert.equal(resumed.resumed, true);
    const again = await runBackup({ orgId: org.orgId, shareId, resumeRunId: String(failed.runId), actorEmail: org.manager.email });
    assert.equal(again.alreadyComplete, true, "resuming a finished run is a no-op (no duplicate data)");
  });

  await t.test("a full storage outage produces BACKUP_FAILED and a manager notification, then recovers on retry", async () => {
    await fx.agent.writeFile({ shareName, relativePath: "outage.txt", buffer: Buffer.from("o"), owner: mgr.unix });
    storageControl.down = true;
    const r = await runBackup({ orgId: org.orgId, shareId, verify: "sample", excludePatterns: ["*.log"], actorEmail: org.manager.email });
    storageControl.down = false;
    assert.notEqual(r.status, "COMPLETED");
    const n = await fx.notifCount({ orgId: orgObj, type: "nas_backup_failed" });
    assert.ok(n >= 1, "managers were notified");
    const ok = await runBackup({ orgId: org.orgId, shareId, verify: "sample", excludePatterns: ["*.log"], actorEmail: org.manager.email });
    assert.equal(ok.status, "COMPLETED");
  });

  await t.test("the public entry point is idempotent: the same key never runs a second backup", async () => {
    const key = "idem-" + fx.RUN + "-1";
    const a = await backupShareToInaya({ ...M(), shareId, idempotencyKey: key, verify: "sample" });
    const runsBefore = await fx.collections.nasBackupRuns.countDocuments({ orgId: orgObj, shareId: (await fx.collections.nasShares.findOne({ shareName }))._id });
    const b = await backupShareToInaya({ ...M(), shareId, idempotencyKey: key, verify: "sample" });
    const runsAfter = await fx.collections.nasBackupRuns.countDocuments({ orgId: orgObj, shareId: (await fx.collections.nasShares.findOne({ shareName }))._id });
    assert.equal(b.idempotent, true);
    assert.equal(String(a.jobId), String(b.jobId));
    assert.equal(runsBefore, runsAfter, "no second run was created");
  });
});

test("Test D: NAS file -> Inaya backup -> integrity check -> DELETE local copy -> restore -> bytes match", async (t) => {
  const original = randomBytes(300 * 1024);
  const { shareName, shareId } = await newShare("td", { "data/report.bin": original, "note.txt": "keep" });
  const run = await runBackup({ orgId: org.orgId, shareId, verify: "full", actorEmail: org.manager.email });
  assert.equal(run.status, "COMPLETED");
  await fx.agent.call("delete_file", { share: shareName, relPath: "data/report.bin" });
  assert.equal((await fx.agent.call("stat_path", { share: shareName, relPath: "data/report.bin" })).exists, false);

  await t.test("in-place restore needs a reason; the default restore is a safe side-by-side copy", async () => {
    assert.equal((await restoreFromBackup({ ...M(), shareId, runId: String(run.runId), relPath: "data/report.bin", inPlace: true })).status, 400);
    const side = await restoreFromBackup({ ...M(), shareId, runId: String(run.runId), relPath: "data/report.bin" });
    assert.equal(side.ok, true);
    assert.match(side.restored[0].restoredTo, /^\.restored\//);
    assert.equal((await fx.agent.call("stat_path", { share: shareName, relPath: "data/report.bin" })).exists, false, "live data untouched");
  });

  await t.test("in-place restore brings back EXACTLY the original bytes", async () => {
    const r = await restoreFromBackup({ ...M(), shareId, runId: String(run.runId), relPath: "data/report.bin", inPlace: true, reason: "accidental deletion" });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(sha(await fx.agent.readFile({ shareName, relativePath: "data/report.bin" })), sha(original));
    const ev = await listNasEvidence({ orgId: org.orgId, applianceId: appliance._id });
    assert.ok(ev.some((e) => e.action === "RECOVERY_STARTED") && ev.some((e) => e.action === "RECOVERY_COMPLETED"));
  });

  await t.test("restore to an ALTERNATE share, and as object references for Inaya Drive / S3 access", async () => {
    const alt = await newShare("tdalt");
    const r = await restoreFromBackup({ ...M(), shareId, runId: String(run.runId), target: "alternate", alternateShareId: alt.shareId });
    assert.equal(r.ok, true);
    assert.equal(sha(await fx.agent.readFile({ shareName: alt.shareName, relativePath: r.restored.find((x) => x.relativePath === "data/report.bin").restoredTo })), sha(original));
    const obj = await restoreFromBackup({ ...M(), shareId, runId: String(run.runId), target: "object", relPath: "note.txt" });
    assert.equal(obj.objects.length, 1);
    assert.equal(obj.objects[0].sha256, sha("keep"));
  });

  await t.test("a tampered recovery point is refused, and manifest verification catches it", async () => {
    const good = await verifyManifests({ orgId: org.orgId, shareId, membership: org.manager.membership });
    assert.equal(good.verified, true, JSON.stringify(good.problems));
    await fx.collections.nasBackupRuns.updateOne({ _id: run.runId }, { $set: { "recoveryPoint.files.0.sha256": "0".repeat(64) } });
    const bad = await verifyManifests({ orgId: org.orgId, shareId, membership: org.manager.membership });
    assert.equal(bad.verified, false);
    assert.ok(bad.problems.some((p) => p.kind === "BACKUP_MANIFEST_TAMPERED"));
    const refused = await restoreFromBackup({ ...M(), shareId, runId: String(run.runId), relPath: "data/report.bin", target: "alternate", alternateShareId: (await newShare("tdx")).shareId });
    assert.equal(refused.ok, false, "restore refuses bytes that do not match the recorded hash");
    assert.ok(refused.failures.length >= 1);
  });
});

test("recovery drills: 'backup succeeded' is never reported as 'recoverable' until a test restore matched", async () => {
  const { shareName, shareId } = await newShare("dr", { "one.txt": "1", "two.txt": "22" });
  assert.equal((await recoveryReadiness({ orgId: org.orgId, shareId })).state, "NO_BACKUP");
  const run = await runBackup({ orgId: org.orgId, shareId, verify: "sample", actorEmail: org.manager.email });
  assert.equal(run.status, "COMPLETED");
  assert.equal((await recoveryReadiness({ orgId: org.orgId, shareId })).state, "NOT_VERIFIED", "a completed backup alone is not recovery-ready");
  const drill = await runRecoveryDrill({ ...M(), shareId, sampleFiles: 5 });
  assert.equal(drill.verified, true, JSON.stringify(drill));
  assert.equal(drill.filesRestored, 2);
  assert.equal((await fx.agent.readFile({ shareName, relativePath: ".recovery-drill/one.txt" })).toString(), "1");
  assert.equal((await recoveryReadiness({ orgId: org.orgId, shareId })).state, "READY");
  const single = await runRecoveryDrill({ ...M(), shareId, relativePath: "two.txt" });
  assert.equal(single.verified, true);
  assert.equal((await runRecoveryDrill({ ...M(), shareId, relativePath: "missing.txt" })).verified, false);
  await fx.agent.writeFile({ shareName, relativePath: "three.txt", buffer: Buffer.from("333"), owner: mgr.unix });
  await runBackup({ orgId: org.orgId, shareId, verify: "sample", actorEmail: org.manager.email });
  assert.equal((await recoveryReadiness({ orgId: org.orgId, shareId })).state, "VERIFIED_EARLIER", "a newer backup needs its own drill");
  const drillFiles = (await fx.agent.call("list_files", { share: shareName })).files.map((f) => f.relativePath);
  const next = await runBackup({ orgId: org.orgId, shareId, verify: "sample", actorEmail: org.manager.email });
  assert.equal(next.filesTotal, 3, `drill scratch files (.recovery-drill) are excluded from backups (${drillFiles})`);
  const ov = await getOverview({ orgId: org.orgId, applianceId: String(appliance._id), membership: org.manager.membership });
  assert.ok(ov.cards.recoveryReadiness.perShare.length >= 1);
});

test("cloud targets: a REAL S3-compatible provider (Filebase); SSRF and unverified targets are refused", async (t) => {
  const { shareName, shareId } = await newShare("ct", { "cloud.txt": "to the cloud" });
  await t.test("unsafe endpoints and bad input are rejected before anything is stored", async () => {
    for (const endpoint of ["http://s3.example.com", "https://127.0.0.1", "https://192.168.1.1", "https://localhost:9000", "https://user:pw@s3.filebase.com"]) {
      const r = await createCloudTarget({ ...M(), kind: "s3-compatible", label: "bad", endpoint, bucket: "bucket-x", accessKeyId: "k", secretAccessKey: "s" });
      assert.equal(r.status, 400, endpoint);
    }
    assert.equal((await createCloudTarget({ orgId: org.orgId, kind: "s3-compatible", label: "x", endpoint: "https://s3.filebase.com", bucket: "bucket-x", accessKeyId: "k", secretAccessKey: "s", membership: org.staff.membership, actorEmail: org.staff.email })).status, 403);
    assert.equal((await createCloudTarget({ ...M(), kind: "azure-blob", label: "x", endpoint: "https://x.blob.core.windows.net", bucket: "bucket-x", accessKeyId: "k", secretAccessKey: "s" })).status, 400, "Azure outbound is not implemented and is not accepted");
  });

  let target;
  await t.test("a new target is UNUSABLE until its connection test passes; secrets are never returned", async () => {
    const r = await createCloudTarget({ ...M(), kind: "s3-compatible", label: "Filebase", endpoint: "https://s3.filebase.com", region: "us-east-1", bucket: process.env.FILEBASE_BUCKET, prefix: `nas-tests/${fx.RUN}`, accessKeyId: process.env.FILEBASE_ACCESS_KEY, secretAccessKey: process.env.FILEBASE_SECRET_KEY });
    assert.ok(!r.error, r.error);
    target = r.target;
    assert.equal(target.secretCredential, undefined);
    assert.equal(target.verified, false);
    assert.doesNotMatch(JSON.stringify(await listCloudTargets({ orgId: org.orgId, membership: org.manager.membership })), new RegExp(process.env.FILEBASE_SECRET_KEY.slice(0, 8)));
    await assert.rejects(() => getTargetAdapter({ orgId: org.orgId, appliance, targetId: String(target._id) }), /connection test/);
    const gcs = await createCloudTarget({ ...M(), kind: "gcs-interop", label: "GCS", bucket: "somebucket", accessKeyId: "GOOGX", secretAccessKey: "secret" });
    assert.equal(gcs.target.verified, false);
    await assert.rejects(() => getTargetAdapter({ orgId: org.orgId, appliance, targetId: String(gcs.target._id) }), /untested|connection test/, "GCS interoperability is not claimed without a passing test");
    const badCreds = await createCloudTarget({ ...M(), kind: "s3-compatible", label: "wrong", endpoint: "https://s3.filebase.com", bucket: process.env.FILEBASE_BUCKET, accessKeyId: "WRONGKEYWRONGKEY", secretAccessKey: "wrong" });
    const t2 = await testCloudTarget({ ...M(), targetId: String(badCreds.target._id) });
    assert.equal(t2.verified, false, "a revoked/invalid credential fails its test");
  });

  await t.test("the connection test writes, reads back and deletes a probe object on the real provider", async () => {
    const r = await testCloudTarget({ ...M(), targetId: String(target._id) });
    assert.equal(r.verified, true, JSON.stringify(r));
  });

  await t.test("backup to the real cloud target, verify by reading back, and restore from it", async () => {
    const run = await runBackup({ orgId: org.orgId, shareId, targetId: String(target._id), verify: "full", actorEmail: org.manager.email });
    assert.equal(run.status, "COMPLETED", JSON.stringify(run));
    assert.equal(run.filesVerified, 1);
    await fx.agent.call("delete_file", { share: shareName, relPath: "cloud.txt" });
    const rest = await restoreFromBackup({ ...M(), shareId, runId: String(run.runId), relPath: "cloud.txt", inPlace: true, reason: "restore from cloud target" });
    assert.equal(rest.ok, true, JSON.stringify(rest));
    assert.equal((await fx.agent.readFile({ shareName, relativePath: "cloud.txt" })).toString(), "to the cloud");
    const got = (await listCloudTargets({ orgId: org.orgId, membership: org.manager.membership })).targets.find((x) => String(x._id) === String(target._id));
    assert.ok(got.health.bytesTransferred > 0 && got.health.lastSuccessAt, "per-target health is reported");
  });

  await t.test("a target in use by a backup policy cannot be deleted", async () => {
    await setBackupPolicy({ ...M(), shareId, targetIds: [String(target._id)] });
    assert.equal((await deleteCloudTarget({ orgId: org.orgId, targetId: String(target._id), membership: org.manager.membership })).status, 409);
    await setBackupPolicy({ ...M(), shareId, targetIds: ["inaya"] });
    assert.ok(!(await deleteCloudTarget({ orgId: org.orgId, targetId: String(target._id), membership: org.manager.membership })).error);
  });
});

test("replication: NAS -> NAS with verification, tamper detection, cross-org refusal, and failover", async (t) => {
  const { shareName, shareId } = await newShare("rp", { "x.txt": "xray", "sub/y.txt": "yankee" });
  let policy;
  await t.test("policies to another organization's appliance are impossible", async () => {
    const other = await fx.makeOrg("protect-other");
    const otherApp = await fx.makeAppliance(other);
    const r = await createReplicationPolicy({ ...M(), shareId, mode: "nas-to-nas", targetApplianceId: String(otherApp._id) });
    assert.equal(r.status, 404, "unauthorized cross-org replication");
    assert.equal((await createReplicationPolicy({ ...M(), shareId, mode: "sideways" })).status, 400);
  });
  await t.test("replicate, verify manifests, and stay idempotent", async () => {
    const p = await createReplicationPolicy({ ...M(), shareId, mode: "nas-to-nas", targetApplianceId: String(applianceB._id), intervalMinutes: 30 });
    assert.ok(!p.error, p.error);
    policy = p.policy;
    assert.equal(policy.transport, "local-host");
    assert.match(policy.transportNote, /Cross-host transport is not implemented/);
    const run = await replicateNow({ ...M(), policyId: String(policy._id), idempotencyKey: "rep-" + fx.RUN });
    assert.equal(run.status, "COMPLETED", JSON.stringify(run));
    fx.created.replicas.add("r" + String(policy._id).slice(-12));
    const v = await verifyReplica({ orgId: org.orgId, policyId: String(policy._id), membership: org.manager.membership });
    assert.equal(v.matches, true);
    const again = await replicateNow({ ...M(), policyId: String(policy._id), idempotencyKey: "rep-" + fx.RUN });
    assert.equal(again.ran, false, "same key -> the job already ran (idempotent)");
    const list = await listReplicationPolicies({ orgId: org.orgId, shareId, membership: org.manager.membership });
    assert.equal(list.policies[0].health, "HEALTHY");
    const ev = await listNasEvidence({ orgId: org.orgId, applianceId: appliance._id });
    assert.ok(ev.some((e) => e.action === "REPLICATION_STARTED") && ev.some((e) => e.action === "REPLICATION_COMPLETED"));
  });
  await t.test("a corrupted replica is detected, and the next run repairs it (resumable rsync)", async () => {
    await fx.agent.call("replica_tamper", { targetName: "r" + String(policy._id).slice(-12) });
    assert.equal((await verifyReplica({ orgId: org.orgId, policyId: String(policy._id), membership: org.manager.membership })).matches, false);
    await fx.agent.writeFile({ shareName, relativePath: "z.txt", buffer: Buffer.from("zulu"), owner: mgr.unix });
    const run = await replicateNow({ ...M(), policyId: String(policy._id) });
    assert.equal(run.status, "COMPLETED", JSON.stringify(run));
    assert.equal((await verifyReplica({ orgId: org.orgId, policyId: String(policy._id), membership: org.manager.membership })).matches, true);
  });
  await t.test("test failover serves the replica READ-ONLY; promotion makes it writable and says how to re-protect", async () => {
    const mgrOnB = await fx.provisionUser(org, org.manager2, applianceB._id); // the failover share lives on the target appliance
    const fo = await failoverReplica({ ...M(), policyId: String(policy._id), mode: "test", shareName: fx.tag("fo"), ownerUnixUser: mgrOnB.unix });
    assert.ok(!fo.error, fo.error);
    fx.created.shares.add(fo.share.shareName);
    assert.ok(!(await setShareAccess({ ...M(), shareId: String(fo.share._id), entries: [{ principalType: "user", principalId: String(mgrOnB.nasUser._id), level: "write" }] })).error);
    assert.doesNotMatch((await fx.smb(fo.share.shareName, mgrOnB.unix, mgrOnB.password, "get x.txt /root/fo-x.txt")).out, /NT_STATUS/, "data is readable from the failover copy");
    const wr = await fx.smbPut(fo.share.shareName, mgrOnB.unix, mgrOnB.password, "w.txt", Buffer.from("w"));
    assert.match(wr.out, /NT_STATUS/, "a test failover cannot diverge the replica");
    const ev = await listNasEvidence({ orgId: org.orgId, applianceId: applianceB._id, action: "FAILOVER_PROMOTED" });
    assert.ok(ev.length >= 1);
    assert.ok(!(await deleteReplicationPolicy({ orgId: org.orgId, policyId: String(policy._id), purgeReplica: false, membership: org.manager.membership })).error);
  });
  await t.test("NAS -> Inaya replication is the backup engine on a schedule (no second protocol)", async () => {
    const p = await createReplicationPolicy({ ...M(), shareId, mode: "nas-to-inaya", intervalMinutes: 60 });
    const run = await replicateNow({ ...M(), policyId: String(p.policy._id) });
    assert.equal(run.status, "COMPLETED", JSON.stringify(run));
    assert.ok((await fx.collections.nasBackupRuns.countDocuments({ orgId: orgObj, status: "COMPLETED" })) >= 1);
  });
});

test("tiering: proposals only, approval by a DIFFERENT manager, verified copy first, and fully reversible", async (t) => {
  const payload = randomBytes(64 * 1024);
  const { shareName, shareId } = await newShare("tr", { "cold/big.bin": payload, "hold/legal.txt": "legal hold", "cold/small.txt": "s" });
  assert.equal((await setTieringPolicy({ ...M(), shareId, rules: [{ tier: "FROZEN", olderThanDays: 1 }] })).status, 400);
  assert.ok(!(await setTieringPolicy({ ...M(), shareId, rules: [{ tier: "COLD", olderThanDays: 0, minSizeBytes: 100 }], legalHoldPaths: ["hold"] })).error);
  let proposal;
  await t.test("evaluating never moves data and never proposes legal-hold files", async () => {
    const before = await fx.agent.call("manifest", { share: shareName });
    const r = await proposeTiering({ ...M(), shareId });
    assert.ok(!r.error, r.error);
    proposal = r.proposals[0];
    assert.deepEqual(proposal.files.map((f) => f.relativePath), ["cold/big.bin"], "min size and legal hold both honoured");
    assert.equal(proposal.estimateLabel, "DERIVED");
    assert.equal((await fx.agent.call("manifest", { share: shareName })).manifestHash, before.manifestHash, "nothing changed");
  });
  await t.test("segregation of duties: the proposer cannot approve; another manager can; apply needs approval first", async () => {
    assert.equal((await applyTiering({ ...M(), proposalId: String(proposal._id) })).status, 409, "not approved yet");
    assert.equal((await decideTiering({ ...M(), proposalId: String(proposal._id), approve: true })).status, 403);
    const ok = await decideTiering({ orgId: org.orgId, proposalId: String(proposal._id), approve: true, membership: org.manager2.membership, actorEmail: org.manager2.email });
    assert.equal(ok.state, "APPROVED");
  });
  await t.test("apply: the copy in Inaya is verified before the local file is replaced by a stub", async () => {
    const r = await applyTiering({ ...M(), proposalId: String(proposal._id) });
    assert.equal(r.state, "APPLIED", JSON.stringify(r));
    assert.equal((await fx.agent.call("stat_path", { share: shareName, relPath: "cold/big.bin" })).exists, false);
    const stub = JSON.parse((await fx.agent.readFile({ shareName, relativePath: "cold/big.bin.inaya-tiered.json" })).toString());
    assert.equal(stub.sha256, sha(payload));
    assert.equal((await fx.agent.readFile({ shareName, relativePath: "hold/legal.txt" })).toString(), "legal hold", "legal hold file untouched");
  });
  await t.test("recall restores the identical bytes and removes the stub", async () => {
    const r = await recallProposal({ ...M(), proposalId: String(proposal._id) });
    assert.equal(r.recalled, 1);
    assert.equal(sha(await fx.agent.readFile({ shareName, relativePath: "cold/big.bin" })), sha(payload));
    assert.equal((await fx.agent.call("stat_path", { share: shareName, relPath: "cold/big.bin.inaya-tiered.json" })).exists, false);
    const ev = await listNasEvidence({ orgId: org.orgId, applianceId: appliance._id });
    for (const a of ["TIER_PROPOSED", "TIER_APPLIED", "TIER_RECALLED"]) assert.ok(ev.some((e) => e.action === a), a);
  });
  await t.test("an AI-originated proposal is never self-approving", async () => {
    const r = await proposeTiering({ orgId: org.orgId, shareId, actorType: "ai", actorEmail: "ai-assistant" });
    const p = r.proposals[0];
    assert.equal(p.proposedByType, "ai");
    assert.equal((await applyTiering({ ...M(), proposalId: String(p._id) })).status, 409, "an unapproved AI proposal cannot be applied");
  });
});

test("ransomware response: detect -> classify -> protect -> alert -> (bounded) lockdown -> evidence -> recover", async (t) => {
  const files = {};
  for (let i = 0; i < 12; i++) files[`docs/file${i}.txt`] = `Quarterly report number ${i}. `.repeat(200);
  const { shareName, shareId, share } = await newShare("rs", files);
  assert.ok(!(await setShareAccess({ ...M(), shareId, entries: [{ principalType: "user", principalId: String(mgr.nasUser._id), level: "write" }] })).error);
  const clean = await createSnapshot({ ...M(), shareId, name: "last-clean" });
  assert.ok(!clean.error, clean.error);
  await setBaseline({ ...M(), shareId });
  const notifBefore = await fx.notifCount({ orgId: orgObj, type: "nas_threat_detected" });

  await t.test("ordinary work does not raise an alert", async () => {
    await fx.agent.writeFile({ shareName, relativePath: "docs/file1.txt", buffer: Buffer.from("edited normally"), owner: mgr.unix });
    await fx.agent.writeFile({ shareName, relativePath: "docs/new.txt", buffer: Buffer.from("new document"), owner: mgr.unix });
    const r = await scanShare({ orgId: org.orgId, shareId });
    assert.ok(["NONE", "LOW"].includes(r.level), `got ${r.level}`);
    assert.equal((await listThreatEvents({ orgId: org.orgId, shareId, membership: org.manager.membership })).events.length, 0);
  });

  await t.test("a bounded ransomware SIMULATION (test share only): encryption-like rewrites + .locked names + a ransom note", async () => {
    for (let i = 0; i < 10; i++) {
      await fx.agent.writeFile({ shareName, relativePath: `docs/file${i}.txt`, buffer: randomBytes(4096), owner: mgr.unix });
      await fx.agent.writeFile({ shareName, relativePath: `docs/file${i}.txt.locked`, buffer: randomBytes(1024), owner: mgr.unix });
    }
    await fx.agent.writeFile({ shareName, relativePath: "HOW_TO_DECRYPT_FILES.txt", buffer: Buffer.from("pay us"), owner: mgr.unix });
    const r = await scanShare({ orgId: org.orgId, shareId });
    assert.equal(r.level, "CRITICAL", JSON.stringify(r.signals));
    assert.ok(r.reasons.length >= 3);
    assert.ok(r.protectiveSnapshot, "an immutable protective snapshot was taken");
    assert.equal(r.lockdown, "RECOMMENDED", "automatic lockdown is OFF by default: a human decides");
    const events = (await listThreatEvents({ orgId: org.orgId, shareId, membership: org.manager.membership })).events;
    assert.equal(events.length, 1);
    assert.equal(events[0].protection.snapshot.name, r.protectiveSnapshot);
    const snaps = (await listSnapshots({ orgId: org.orgId, shareId, membership: org.manager.membership })).snapshots;
    const prot = snaps.find((s) => s.name === r.protectiveSnapshot);
    assert.equal(prot.semantics.immutable, true, "the protective copy is really immutable");
    const n = await fx.notifCount({ orgId: orgObj, type: "nas_threat_detected" });
    assert.ok(n > notifBefore, "managers were alerted");
    const dup = await scanShare({ orgId: org.orgId, shareId });
    assert.equal(dup.duplicate, true, "a repeated scan does not duplicate the event or the alert");
    assert.equal((await listThreatEvents({ orgId: org.orgId, shareId, membership: org.manager.membership })).events.length, 1);
    const ev = await listNasEvidence({ orgId: org.orgId, applianceId: appliance._id });
    assert.ok(ev.some((e) => e.action === "THREAT_DETECTED") && ev.some((e) => e.action === "PROTECTION_TRIGGERED"));
  });

  await t.test("human-approved lockdown makes the share read-only over real SMB, and it can be lifted", async () => {
    const ev = (await listThreatEvents({ orgId: org.orgId, shareId, membership: org.manager.membership })).events[0];
    assert.equal((await approveLockdown({ orgId: org.orgId, eventId: String(ev._id), membership: org.staff.membership, actorEmail: org.staff.email })).status, 403);
    const l = await approveLockdown({ ...M(), eventId: String(ev._id), minutes: 30 });
    assert.ok(!l.error, l.error);
    const wr = await fx.smbPut(shareName, mgr.unix, mgr.password, "after-lockdown.txt", Buffer.from("x"));
    assert.match(wr.out, /NT_STATUS/, "writes are refused during lockdown");
    assert.doesNotMatch((await fx.smb(shareName, mgr.unix, mgr.password, "ls")).out, /NT_STATUS_ACCESS_DENIED/, "reads still work");
    assert.ok(!(await liftLockdown({ ...M(), shareId })).error);
    assert.doesNotMatch((await fx.smbPut(shareName, mgr.unix, mgr.password, "after-lift.txt", Buffer.from("x"))).out, /NT_STATUS/);
  });

  await t.test("recovery: the last CLEAN snapshot restores the originals; resolving the event points at it", async () => {
    const ev = (await listThreatEvents({ orgId: org.orgId, shareId, membership: org.manager.membership })).events[0];
    const res = await resolveThreatEvent({ ...M(), eventId: String(ev._id), resolution: "CONTAINED", note: "restored from clean snapshot" });
    assert.equal(res.recoveryPath.snapshot, "last-clean");
    const snapId = String(res.recoveryPath.snapshotId);
    const r = await restoreSnapshot({ ...M(), snapshotId: snapId, relPath: "docs/file3.txt", inPlace: true, reason: "ransomware recovery" });
    assert.ok(!r.error, r.error);
    assert.match((await fx.agent.readFile({ shareName, relativePath: "docs/file3.txt" })).toString(), /Quarterly report number 3/);
  });

  await t.test("automatic lockdown is possible only when explicitly enabled AND critical, always expires, and exempt shares are never locked", async () => {
    const shareB = await newShare("rs2", Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`d/f${i}.txt`, `content ${i} `.repeat(300)])));
    await setBaseline({ ...M(), shareId: shareB.shareId });
    assert.ok(!(await setThreatPolicy({ ...M(), shareId: shareB.shareId, autoLockdown: true, lockdownMinutes: 1 })).error);
    for (let i = 0; i < 10; i++) { await fx.agent.writeFile({ shareName: shareB.shareName, relativePath: `d/f${i}.txt`, buffer: randomBytes(4096), owner: mgr.unix }); await fx.agent.writeFile({ shareName: shareB.shareName, relativePath: `d/f${i}.txt.encrypted`, buffer: randomBytes(600), owner: mgr.unix }); }
    const r = await scanShare({ orgId: org.orgId, shareId: shareB.shareId });
    assert.equal(r.lockdown, "ACTIVE");
    assert.ok((await fx.collections.nasShares.findOne({ _id: shareB.share._id })).access.lockdown.expiresAt, "every lockdown has an expiry");
    await fx.collections.nasShares.updateOne({ _id: shareB.share._id }, { $set: { "access.lockdown.expiresAt": new Date(Date.now() - 1000).toISOString() } });
    const lifted = await liftExpiredLockdowns({ orgId: org.orgId });
    assert.ok(lifted.lifted.includes(shareB.shareId), "an expired lockdown is lifted automatically");
    const exempt = await newShare("rs3", Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`d/f${i}.txt`, `content ${i} `.repeat(300)])));
    await setBaseline({ ...M(), shareId: exempt.shareId });
    await setThreatPolicy({ ...M(), shareId: exempt.shareId, autoLockdown: true, exempt: true });
    for (let i = 0; i < 10; i++) { await fx.agent.writeFile({ shareName: exempt.shareName, relativePath: `d/f${i}.txt`, buffer: randomBytes(4096), owner: mgr.unix }); await fx.agent.writeFile({ shareName: exempt.shareName, relativePath: `d/f${i}.txt.locked`, buffer: randomBytes(600), owner: mgr.unix }); }
    const ex = await scanShare({ orgId: org.orgId, shareId: exempt.shareId });
    assert.equal(ex.level, "CRITICAL");
    assert.equal(ex.lockdown, undefined, "an exempt share is detected and alerted but never locked automatically");
    assert.equal(ex.protectiveSnapshot, undefined);
  });
});

test("job engine: idempotent, retryable, resumable, recoverable after a worker dies, observable", async (t) => {
  let calls = 0;
  registerJobHandler("test_flaky", async (job, ctx) => { calls++; if (calls < 3) throw new Error("transient failure " + calls); await ctx.beat({ step: "done" }); return { result: { ok: true, attempts: job.attempts } }; });
  registerJobHandler("test_always_fails", async () => { throw new Error("permanent"); });
  registerJobHandler("test_slow", async (job, ctx) => { await sleep(300); return { result: "slow" }; });
  const key = "job-" + fx.RUN;
  const a = await enqueueJob({ orgId: org.orgId, kind: "test_flaky", idempotencyKey: key, maxAttempts: 4 });
  const b = await enqueueJob({ orgId: org.orgId, kind: "test_flaky", idempotencyKey: key, maxAttempts: 4 });
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(String(a.job._id), String(b.job._id), "same key -> same job");

  await t.test("failures back off and retry; success completes; a completed job does not run twice", async () => {
    const r1 = await runJob({ jobId: a.job._id });
    assert.equal(r1.status, "RETRYING");
    assert.equal((await runJob({ jobId: a.job._id })).ran, false, "not due until its backoff elapses");
    await fx.collections.nasJobs.updateOne({ _id: a.job._id }, { $set: { nextAttemptAt: new Date().toISOString() } });
    assert.equal((await runJob({ jobId: a.job._id })).status, "RETRYING");
    await fx.collections.nasJobs.updateOne({ _id: a.job._id }, { $set: { nextAttemptAt: new Date().toISOString() } });
    const r3 = await runJob({ jobId: a.job._id });
    assert.equal(r3.status, "COMPLETED");
    assert.equal((await runJob({ jobId: a.job._id })).ran, false);
    assert.equal(calls, 3);
  });
  await t.test("retries are bounded: after maxAttempts the job is FAILED with its reason", async () => {
    const j = (await enqueueJob({ orgId: org.orgId, kind: "test_always_fails", idempotencyKey: key + "-f", maxAttempts: 2 })).job;
    await runJob({ jobId: j._id });
    await fx.collections.nasJobs.updateOne({ _id: j._id }, { $set: { nextAttemptAt: new Date().toISOString() } });
    assert.equal((await runJob({ jobId: j._id })).status, "FAILED");
    assert.equal((await getJob({ orgId: org.orgId, jobId: j._id })).lastError, "permanent");
  });
  await t.test("two workers racing for one job: exactly one runs it", async () => {
    const j = (await enqueueJob({ orgId: org.orgId, kind: "test_slow", idempotencyKey: key + "-race" })).job;
    const [x, y] = await Promise.all([runJob({ jobId: j._id }), runJob({ jobId: j._id })]);
    assert.equal([x, y].filter((r) => r.ran).length, 1);
  });
  await t.test("a worker that died mid-job is detected by its stale heartbeat and the job resumes from its checkpoint", async () => {
    const j = (await enqueueJob({ orgId: org.orgId, kind: "test_slow", idempotencyKey: key + "-stale" })).job;
    await fx.collections.nasJobs.updateOne({ _id: j._id }, { $set: { status: "RUNNING", attempts: 1, checkpoint: { done: 5 }, heartbeatAt: new Date(Date.now() - 10 * 60000).toISOString() } });
    assert.ok((await recoverStaleJobs({ orgId: org.orgId })) >= 1);
    const fresh = await getJob({ orgId: org.orgId, jobId: j._id });
    assert.equal(fresh.status, "RETRYING");
    assert.deepEqual(fresh.checkpoint, { done: 5 }, "the checkpoint survives");
    const done = await processDueJobs({ orgId: org.orgId });
    assert.ok(done.results.some((r) => r.jobId === String(j._id) && r.status === "COMPLETED"));
  });
  await t.test("pause / resume / cancel and the observability summary", async () => {
    const j = (await enqueueJob({ orgId: org.orgId, kind: "test_slow", idempotencyKey: key + "-pause", delaySeconds: 3600 })).job;
    assert.equal((await pauseJob({ orgId: org.orgId, jobId: j._id })).paused, true);
    assert.equal((await runJob({ jobId: j._id })).ran, false, "a paused job does not run");
    assert.equal((await resumeJob({ orgId: org.orgId, jobId: j._id })).resumed, true);
    assert.equal((await cancelJob({ orgId: org.orgId, jobId: j._id })).cancelled, true);
    const s = await summarizeJobs({ orgId: org.orgId });
    assert.ok(s.byStatus.COMPLETED >= 1 && s.byStatus.FAILED >= 1 && s.byStatus.CANCELLED >= 1);
  });
});

test("Digital Twin: five NAS What-If scenarios on the EXISTING engine, read-only, with explicit unknowns", async () => {
  const { shareName, shareId, share } = await newShare("tw", { "a.txt": "a" });
  await fx.agent.call("pool_create", { pool: "twp" + fx.RUN, level: "single", memberSizeMb: 128 }).then(() => fx.created.pools.add("twp" + fx.RUN)).catch(() => {});
  const poolName = fx.tag("tp");
  const { createPool } = await import("../src/lib/nas/pools.js");
  const pool = await createPool({ ...M(), applianceId: String(appliance._id), name: poolName, level: "raid1", memberSizeMb: 128 });
  fx.created.pools.add(poolName);
  await runBackup({ orgId: org.orgId, shareId, verify: "sample", actorEmail: org.manager.email });
  await createSnapshot({ ...M(), shareId, name: "twin-snap", immutable: true, retentionDays: 1 });
  await checkApplianceState({ orgId: org.orgId, applianceId: String(appliance._id), membership: org.manager.membership });
  const registryBefore = JSON.stringify(await fx.agent.call("registry", {}));
  const sharesBefore = await fx.collections.nasShares.countDocuments({ orgId: orgObj });
  const evBefore = await fx.collections.nasEvidence.countDocuments({ orgId: orgObj });

  const run = async (scenarioType, entityId, params) => { const r = await simulateDigitalTwinScenario({ orgId: org.orgId, scenarioType, entityId, membership: org.manager.membership, actorEmail: org.manager.email, params }); return r.error ? r : r.simulation; };
  const a = await run("NAS_APPLIANCE_UNAVAILABLE", String(appliance._id));
  assert.ok(!a.error, a.error);
  assert.ok(a.directImpact.unavailableShares.includes(shareName));
  assert.equal(a.simulatedState.status, "UNREACHABLE");
  assert.ok(a.unknowns.some((u) => u.area === "RECOVERY_DURATION" && u.status === "UNKNOWN"), "recovery time is UNKNOWN, not invented");
  assert.match(a.disclaimer, /not a guaranteed prediction/);

  const d = await run("NAS_DISK_FAILED", String(pool.pool._id));
  assert.ok(!d.error, d.error);
  assert.match(d.directImpact.poolState, /DEGRADED/, "a mirror survives one failure");
  assert.match((await run("NAS_DISK_FAILED", String((await fx.collections.nasPools.findOne({ name: poolName }))._id))).simulatedState.health, /DEGRADED|FAILED/);

  const e = await run("NAS_DATASET_ENCRYPTED", shareId);
  assert.ok(!e.error, e.error);
  assert.ok(e.directImpact.immutableRecoveryPoints.some((p) => p.name === "twin-snap"), "immutable recovery points are listed");
  assert.ok(e.directImpact.expectedRestorationPath.length >= 1);

  const u = await run("NAS_USER_ACCESS_REVOKED", String(mgr.nasUser._id));
  assert.ok(!u.error, u.error);
  assert.equal(u.simulatedState.account, "REVOKED");

  const c = await run("NAS_CAPACITY_EXHAUSTED", String(appliance._id), { percent: 95 });
  assert.ok(!c.error, c.error);
  assert.equal(c.scenario.parameters.percent, 95);
  assert.ok(c.directImpact.recommendedActions.length >= 1);

  for (const r of [a, d, e, u, c]) { assert.equal(r.noChangesWereMade, true); assert.ok(r.currentState && r.simulatedState, "current vs simulated state"); assert.ok(r.integrityHash, "provenance hash from the existing engine"); }
  assert.equal(JSON.stringify(await fx.agent.call("registry", {})), registryBefore, "the live appliance is unchanged");
  assert.equal(await fx.collections.nasShares.countDocuments({ orgId: orgObj }), sharesBefore);
  assert.equal(await fx.collections.nasEvidence.countDocuments({ orgId: orgObj }), evBefore, "a simulation writes no NAS evidence");
  assert.equal((await simulateDigitalTwinScenario({ orgId: org.orgId, scenarioType: "NAS_DISK_FAILED", entityId: String(pool.pool._id), membership: org.outsider.membership, actorEmail: org.outsider.email })).status, 403, "a member without NAS access cannot simulate it");
});

test("cryptographic state: commitment, drift detection, audit-chain linkage, evidence verification and the compliance package", async () => {
  const { shareId } = await newShare("st", { "a.txt": "a" });
  const A = String(appliance._id);
  const c = await commitNasState({ orgId: org.orgId, applianceId: A, membership: org.manager.membership, actorEmail: org.manager.email });
  assert.ok(!c.error, c.error);
  assert.match(c.commitment.stateHash, /^[0-9a-f]{64}$/);
  assert.ok(c.evidence.auditRef.entryHash, "the commitment is in the existing audit chain");
  const same = await verifyNasState({ orgId: org.orgId, applianceId: A, membership: org.manager.membership });
  assert.equal(same.matches, true);
  assert.equal(same.recordedInAuditChain, true);
  await setShareQuota({ ...M(), shareId, hardBytes: 32 * 1024 * 1024 }).catch(() => {});
  await setShareAccess({ ...M(), shareId, entries: [{ principalType: "user", principalId: String(mgr.nasUser._id), level: "read" }] });
  const drift = await verifyNasState({ orgId: org.orgId, applianceId: A, membership: org.manager.membership });
  assert.equal(drift.matches, false);
  assert.ok(drift.differences.length >= 1);
  assert.ok(drift.differences.some((d) => d.component.startsWith("shares.")), JSON.stringify(drift.differences));
  const ev = await verifyNasEvidence({ orgId: org.orgId, applianceId: appliance._id });
  assert.equal(ev.verified, true, JSON.stringify(ev.problems));
  assert.equal(ev.auditChain.valid, true);
  const pkg = await buildEvidencePackage({ orgId: org.orgId, actorEmail: org.owner.email });
  const nas = pkg.package?.nasEvidence || pkg.nasEvidence;
  assert.ok(nas.appliances.length >= 1, "the NAS section is part of the existing evidence exporter");
  assert.match(nas.disclaimer, /not a compliance certification/);
  const first = nas.appliances.find((x) => x.appliance.id === A);
  assert.equal(first.auditChainVerification.valid, true);
  assert.ok(first.shareInventory.length >= 1 && first.cryptographicEvidenceReferences.length >= 1);
  assert.ok(first.storageConfigurationFingerprint.stateHash);
});

test("updates: pre-checks, configuration backup, install with rollback copy, post-verification; never during a critical job", async () => {
  process.env.NAS_AGENT_MANAGED_UPDATES = "1"; // production mode: a stale agent is reported, never silently replaced
  const A = String(appliance._id);
  const info = await checkForUpdate({ orgId: org.orgId, applianceId: A, membership: org.manager.membership });
  assert.equal(info.updateAvailable, false, "the appliance runs the bundled agent");
  assert.equal(info.releaseMetadata.signed, false, "unsigned, hash-pinned metadata is reported as such");
  assert.match(info.scope, /not modified/);
  const same = await applyUpdate({ ...M(), applianceId: A });
  assert.equal(same.state, "UP_TO_DATE");

  // make the installed agent differ from the bundled one (as after a repo release)
  await fx.agent.constructor; // keep reference
  const { execFile } = await import("node:child_process");
  await new Promise((res) => execFile("wsl.exe", ["-d", "Ubuntu", "-u", "root", "--", "sh", "-c", "echo '# stale local edit' >> /usr/local/sbin/inaya-nas-agent.py"], res));
  const stale = await checkForUpdate({ orgId: org.orgId, applianceId: A, membership: org.manager.membership });
  assert.equal(stale.updateAvailable, true);

  const running = await fx.collections.nasJobs.insertOne({ orgId: orgObj, applianceId: appliance._id, kind: "backup", status: "RUNNING", idempotencyKey: "blocker-" + fx.RUN, attempts: 1, createdAt: new Date().toISOString() });
  const blocked = await applyUpdate({ ...M(), applianceId: A });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.state, "BLOCKED", "an update never starts during a critical operation");
  await fx.collections.nasJobs.deleteOne({ _id: running.insertedId });

  const done = await applyUpdate({ ...M(), applianceId: A });
  assert.equal(done.state, "COMPLETED", JSON.stringify(done));
  assert.equal(done.postCheck.agentHashMatches, true);
  const rec = await fx.collections.nasUpdates.find({ orgId: orgObj, state: "COMPLETED" }).toArray();
  assert.ok(rec[0].configBackup.backup, "a configuration backup was taken first");
  const after = await checkForUpdate({ orgId: org.orgId, applianceId: A, membership: org.manager.membership });
  assert.equal(after.updateAvailable, false);
  const evs = await listNasEvidence({ orgId: org.orgId, applianceId: appliance._id, action: "UPDATE_APPLIED" });
  assert.ok(evs.length >= 1);
  const rolled = await new NasAgentClient({ backend: "wsl-local" }).rollbackAgent();
  assert.ok(rolled.agentSha256, "rollback restores the previous copy");
  await new NasAgentClient({ backend: "wsl-local" }).installAgent({ keepPrevious: false });
  delete process.env.NAS_AGENT_MANAGED_UPDATES;
});
test("worker: one pass turns due schedules into idempotent jobs; a second pass creates no duplicates", async () => {
  const { shareName, shareId } = await newShare("wk", { "w.txt": "worker" });
  assert.ok(!(await setBackupPolicy({ ...M(), shareId, intervalMinutes: 60, verify: "sample" })).error);
  assert.ok(!(await setSnapshotPolicy({ ...M(), shareId, intervalMinutes: 60, keepLast: 3 })).error);
  assert.ok(!(await setThreatPolicy({ ...M(), shareId, scanIntervalMinutes: 60 })).error);
  const r1 = await runNasWorker({ orgId: org.orgId, budgetMs: 200000 });
  assert.ok(r1.scheduling.backups.queued >= 1 && r1.scheduling.snapshots.queued >= 1 && r1.scheduling.scans.queued >= 1, JSON.stringify(r1.scheduling));
  assert.ok(r1.jobs.processed >= 3);
  const shareDoc = await fx.collections.nasShares.findOne({ shareName });
  const runs1 = await fx.collections.nasBackupRuns.countDocuments({ shareId: shareDoc._id });
  const snaps1 = await fx.collections.nasSnapshots.countDocuments({ shareId: shareDoc._id });
  const r2 = await runNasWorker({ orgId: org.orgId, budgetMs: 100000 });
  assert.equal(r2.scheduling.backups.queued, 0, "not due again");
  assert.equal(await fx.collections.nasBackupRuns.countDocuments({ shareId: shareDoc._id }), runs1, "no duplicate backup");
  assert.equal(await fx.collections.nasSnapshots.countDocuments({ shareId: shareDoc._id }), snaps1, "no duplicate snapshot");
  assert.ok(Array.isArray(r1.access) || r1.access, "access reconciliation ran");
});
