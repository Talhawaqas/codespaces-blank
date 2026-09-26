// test/nas-unit.test.mjs
// Sovereign NAS SOW Section 48 unit tests: ACL mapping, quota calculation,
// policy evaluation, backup selection, retention, manifest hashing, evidence
// vocabulary, threat classification, twin state conversion, SSRF guard.
// Pure logic: no appliance needed.
// Run: node --env-file=.env.local --test test/nas-unit.test.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import mongoClientPromise from "../src/lib/mongodb.js";
import { orgEligibility, buildShareSpec, accessPolicyHash } from "../src/lib/nas/access.js";
import { quotaState, isWorse, QUOTA_STATES } from "../src/lib/nas/quotas.js";
import { classifyThreat, DEFAULT_THRESHOLDS } from "../src/lib/nas/ransomware.js";
import { selectedByPolicy, planBackup, manifestHashOf } from "../src/lib/nas/backup.js";
import { replicationHealth } from "../src/lib/nas/replication.js";
import { isUnderLegalHold } from "../src/lib/nas/tiering.js";
import { stateComponentsFrom } from "../src/lib/nas/state.js";
import { assertSafeEndpoint } from "../src/lib/nas/cloudTargets.js";
import { NAS_EVENTS } from "../src/lib/nas/evidence.js";
import { NAS_SCENARIO_TYPES } from "../src/lib/nas/twin.js";
import { SCENARIO_TYPES } from "../src/lib/digitalTwinSimulate.js";
import { enqueueJob, JOB_STATES } from "../src/lib/nas/jobs.js";

after(async () => { const c = await mongoClientPromise; await c.close(); });

test("ACL mapping: org eligibility is fail-closed", () => {
  assert.equal(orgEligibility({ membership: null, share: {} }).eligible, false);
  assert.equal(orgEligibility({ membership: { role: "member" }, share: {} }).eligible, false, "no nasRole -> no access");
  assert.equal(orgEligibility({ membership: { role: "member", nasRole: "staff" }, share: {} }).eligible, true);
  assert.equal(orgEligibility({ membership: { role: "owner" }, share: {} }).eligible, true);
});

test("ACL mapping: share policy renders deterministic Samba lists, deny wins, unknown principals are dropped", () => {
  const usersById = new Map([["u1", { unixUsername: "nasalice" }], ["u2", { unixUsername: "nasbob" }], ["u3", { unixUsername: "nasmallory" }]]);
  const groupsById = new Map([["g1", { unixGroup: "nasg_finance" }]]);
  const share = { shareName: "docs", ownerUnixUser: "nasalice", access: { entries: [
    { principalType: "user", principalId: "u1", level: "write" }, { principalType: "user", principalId: "u2", level: "read" },
    { principalType: "group", principalId: "g1", level: "write" }, { principalType: "user", principalId: "u3", level: "deny" }, { principalType: "user", principalId: "ghost", level: "write" },
  ], hostsAllow: ["10.0.0.0/8"], readOnly: false, hidden: true, enabled: true } };
  const spec = buildShareSpec({ share, usersById, groupsById });
  assert.deepEqual(spec.validUsers, ["@nasg_finance", "nasalice", "nasbob"]);
  assert.deepEqual(spec.readList, ["nasbob"]);
  assert.deepEqual(spec.writeList, ["@nasg_finance", "nasalice"]);
  assert.deepEqual(spec.invalidUsers, ["nasmallory"]);
  assert.equal(spec.hidden, true);
  assert.deepEqual(buildShareSpec({ share, usersById, groupsById }), spec, "deterministic");
  const h1 = accessPolicyHash(share);
  share.access.entries[1].level = "write";
  assert.notEqual(accessPolicyHash(share), h1, "the policy hash changes when access changes");
});

test("quota calculation: NORMAL -> WARNING -> NEAR_LIMIT -> HARD_LIMIT -> FULL", () => {
  const hard = 1000;
  assert.equal(quotaState({ usedBytes: 100, hardBytes: hard }), "NORMAL");
  assert.equal(quotaState({ usedBytes: 800, hardBytes: hard }), "WARNING");
  assert.equal(quotaState({ usedBytes: 960, hardBytes: hard }), "NEAR_LIMIT");
  assert.equal(quotaState({ usedBytes: 1000, hardBytes: hard }), "HARD_LIMIT");
  assert.equal(quotaState({ usedBytes: 10, hardBytes: hard, freeBytes: 100 }), "FULL", "a physically full filesystem is FULL whatever the quota says");
  assert.equal(quotaState({ usedBytes: 500, hardBytes: null, softBytes: 400 }), "WARNING", "soft quota without a hard one");
  assert.equal(quotaState({ usedBytes: 500, hardBytes: null }), "NORMAL");
  assert.ok(isWorse("HARD_LIMIT", "WARNING") && !isWorse("NORMAL", "WARNING"));
  assert.deepEqual(QUOTA_STATES, ["NORMAL", "WARNING", "NEAR_LIMIT", "HARD_LIMIT", "FULL"]);
});

test("threat classification: ordinary edits are not ransomware, encryption-like rewrites are", () => {
  const busy = classifyThreat({ baselineFiles: 100, modified: 40, deleted: 0, extensionChanges: 0, highEntropyRewrites: 0, ransomNotes: 0 });
  assert.ok(["LOW", "MEDIUM"].includes(busy.level), `bulk editing alone is at most MEDIUM, got ${busy.level}`);
  const attack = classifyThreat({ baselineFiles: 100, modified: 80, deleted: 0, extensionChanges: 60, highEntropyRewrites: 70, ransomNotes: 1 });
  assert.equal(attack.level, "CRITICAL");
  assert.ok(attack.reasons.length >= 3);
  assert.equal(classifyThreat({ baselineFiles: 100 }).level, "NONE");
  assert.equal(classifyThreat({ baselineFiles: 100, snapshotDeleteAttempts: 1 }).level, "MEDIUM", "a snapshot-deletion attempt is a signal");
  assert.equal(classifyThreat({ baselineFiles: 10, failedLogons: 50 }).score, 15, "repeated failed logons add weight");
  assert.ok(DEFAULT_THRESHOLDS.failedLogons > 0);
  const strict = classifyThreat({ baselineFiles: 100, extensionChanges: 3 }, { extensionChanges: 2 });
  assert.ok(strict.score >= 40, "thresholds are configurable");
});

test("backup selection, deduplication planning and manifest hashing", () => {
  assert.equal(selectedByPolicy("a/b.txt", {}), true);
  assert.equal(selectedByPolicy("a/b.txt", { includePaths: ["a"] }), true);
  assert.equal(selectedByPolicy("c/b.txt", { includePaths: ["a"] }), false);
  assert.equal(selectedByPolicy("a/tmp.log", { excludePatterns: ["*.log"] }), false);
  assert.equal(selectedByPolicy("a/node_modules/x.js", { excludePatterns: ["node_modules"] }), false);
  const files = [{ relativePath: "same", sha256: "1" }, { relativePath: "changed", sha256: "2" }, { relativePath: "new", sha256: "3" }];
  const index = new Map([["same", { sha256: "1" }], ["changed", { sha256: "old" }]]);
  const plan = planBackup(files, index);
  assert.deepEqual(plan.skip.map((f) => f.relativePath), ["same"], "identical content is not uploaded again");
  assert.deepEqual(plan.upload.map((f) => f.relativePath).sort(), ["changed", "new"]);
  const a = manifestHashOf([{ relativePath: "x", sizeBytes: 1, sha256: "a" }, { relativePath: "y", sizeBytes: 2, sha256: "b" }]);
  assert.equal(a, manifestHashOf([{ relativePath: "y", sizeBytes: 2, sha256: "b" }, { relativePath: "x", sizeBytes: 1, sha256: "a" }]), "order independent");
  assert.notEqual(a, manifestHashOf([{ relativePath: "x", sizeBytes: 1, sha256: "a" }, { relativePath: "y", sizeBytes: 2, sha256: "TAMPERED" }]), "tamper evident");
});

test("retention / replication health / tiering legal hold policy evaluation", () => {
  const now = Date.now();
  const p = { enabled: true, intervalMinutes: 60, lastSuccessAt: new Date(now - 30 * 60000).toISOString() };
  assert.equal(replicationHealth(p, now), "HEALTHY");
  assert.equal(replicationHealth({ ...p, lastSuccessAt: new Date(now - 3 * 3600000).toISOString() }, now), "DEGRADED", "older than twice the interval");
  assert.equal(replicationHealth({ ...p, lastFailureAt: new Date(now).toISOString() }, now), "FAILED");
  assert.equal(replicationHealth({ enabled: true, intervalMinutes: 60 }, now), "PENDING");
  assert.equal(replicationHealth({ ...p, enabled: false }, now), "DISABLED");
  assert.equal(isUnderLegalHold("legal/case1/a.pdf", ["legal"]), true);
  assert.equal(isUnderLegalHold("legalese/a.pdf", ["legal"]), false, "prefix match respects path boundaries");
});

test("state commitments: every component hashes, and a change to one share changes only that component", () => {
  const share = { shareName: "a", backend: "btrfs", access: { entries: [], hostsAllow: [] }, quota: { hardBytes: 10, enforced: true } };
  const c1 = stateComponentsFrom({ shares: [share, { ...share, shareName: "b" }], applianceFingerprint: "fp" });
  const c2 = stateComponentsFrom({ shares: [{ ...share, quota: { hardBytes: 20, enforced: true } }, { ...share, shareName: "b" }], applianceFingerprint: "fp" });
  assert.notEqual(c1.shares.a, c2.shares.a);
  assert.equal(c1.shares.b, c2.shares.b);
});

test("SSRF guard: cloud targets can never point at internal addresses", async () => {
  for (const bad of ["http://s3.example.com", "https://localhost", "https://127.0.0.1", "https://10.0.0.5", "https://192.168.1.10", "https://169.254.169.254", "https://user:pw@s3.amazonaws.com", "https://[::1]", "not a url"]) {
    await assert.rejects(() => assertSafeEndpoint(bad), Error, bad);
  }
  await assert.doesNotReject(() => assertSafeEndpoint("https://s3.filebase.com"));
});

test("evidence vocabulary covers every SOW Workstream U event; twin scenarios are registered in the existing engine", () => {
  for (const e of ["SHARE_CREATED", "SHARE_PERMISSION_CHANGED", "USER_GRANTED_ACCESS", "USER_REVOKED_ACCESS", "FILE_DELETED", "FILE_RESTORED", "SNAPSHOT_CREATED", "SNAPSHOT_LOCKED", "BACKUP_STARTED", "BACKUP_VERIFIED", "BACKUP_FAILED", "REPLICATION_STARTED", "REPLICATION_COMPLETED", "REPLICATION_FAILED", "RECOVERY_STARTED", "RECOVERY_COMPLETED", "RECOVERY_FAILED", "THREAT_DETECTED", "PROTECTION_TRIGGERED", "POLICY_CHANGED", "REMOTE_ACCESS_ENABLED"]) assert.ok(NAS_EVENTS.includes(e), e);
  for (const t of NAS_SCENARIO_TYPES) assert.ok(SCENARIO_TYPES.includes(t), t);
  assert.deepEqual(JOB_STATES, ["QUEUED", "RUNNING", "PAUSED", "COMPLETED", "FAILED", "CANCELLED", "RETRYING", "DEGRADED", "RECOVERY_REQUIRED"], "SOW 39 states");
  assert.equal(typeof enqueueJob, "function");
});
