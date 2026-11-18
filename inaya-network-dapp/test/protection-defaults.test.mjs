// test/protection-defaults.test.mjs -- ransomware protection on by default (src/lib/protectionDefaults.js, 17 Nov 2026):
// new S3-compatible buckets are versioned with a 30-day old-version lifecycle rule; new NAS shares get a daily, immutable
// snapshot schedule. Existing buckets are left alone. Runs against the test database and the real NAS appliance VM.
process.env.S3_DEFAULT_VERSIONING = "on";
process.env.NAS_DEFAULT_SNAPSHOTS = "on";
process.env.NAS_DEFAULT_OFFSITE_BACKUP = "on";
process.env.S3_DEFAULT_TRIPWIRE = "on";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import * as fx from "./_nas-fixtures.mjs";
import { installMemoryProviders } from "./_docauto-fixtures.mjs";
import { putS3Object, getS3ObjectBody, getBucketVersioning, getLifecyclePolicy, putBucketVersioning, deleteS3Bucket, getS3Bucket } from "../src/lib/s3-compat/store.js";
import { getOrgCollections } from "../src/lib/orgs.js";
import { classifyCloudThreat } from "../src/lib/ransomware/cloud.js";
import { getBackupPolicy } from "../src/lib/nas/backup.js";
import { applyProtectionDefaults } from "../src/lib/protectionBackfill.js";
import { ensureOwnerS3Passphrase } from "../src/lib/s3-compat/credentials.js";
import { createShare } from "../src/lib/nas/shares.js";
import { getSnapshotPolicy } from "../src/lib/nas/snapshots.js";
import { NONCURRENT_VERSION_DAYS, DEFAULT_NAS_SNAPSHOT_POLICY, DEFAULT_NAS_BACKUP_POLICY } from "../src/lib/protectionDefaults.js";

let org; let appliance; let mgr;
const M = () => ({ orgId: org.orgId, membership: org.manager.membership, actorEmail: org.manager.email });
before(async () => {
  await fx.setup(); installMemoryProviders();
  org = await fx.makeOrg("defaults");
  await ensureOwnerS3Passphrase({ type: "org", orgId: org.orgId });
});
after(async () => { await fx.teardown(); });

test("a new bucket is versioned with a 30-day old-version rule; an overwrite can be rolled back", { timeout: 120000 }, async () => {
  const bucket = `protected-${randomBytes(3).toString("hex")}`;
  const v1 = Buffer.from("original contract"); const v2 = Buffer.from("ENCRYPTED BY RANSOMWARE");
  const first = await putS3Object({ orgId: org.orgId, bucket, key: "contract.txt", bodyBuffer: v1, actorEmail: "sqa" });
  await putS3Object({ orgId: org.orgId, bucket, key: "contract.txt", bodyBuffer: v2, actorEmail: "sqa" });
  assert.equal((await getBucketVersioning({ orgId: org.orgId, bucket })).versioningStatus, "Enabled");
  const rules = (await getLifecyclePolicy({ orgId: org.orgId, bucket })).rules;
  assert.equal(rules[0].noncurrentVersionExpirationDays, NONCURRENT_VERSION_DAYS);
  assert.equal((await getS3ObjectBody({ orgId: org.orgId, bucket, key: "contract.txt" })).buffer.toString(), "ENCRYPTED BY RANSOMWARE");
  const old = await getS3ObjectBody({ orgId: org.orgId, bucket, key: "contract.txt", versionId: first.versionId });
  assert.equal(old.buffer.toString(), "original contract", "the version before the overwrite is still there");
});

test("a bucket created while the default is off keeps its own setting (existing buckets are never changed)", { timeout: 60000 }, async () => {
  process.env.S3_DEFAULT_VERSIONING = "off";
  const bucket = `plain-${randomBytes(3).toString("hex")}`;
  await putS3Object({ orgId: org.orgId, bucket, key: "a.txt", bodyBuffer: Buffer.from("a"), actorEmail: "sqa" });
  process.env.S3_DEFAULT_VERSIONING = "on";
  await putS3Object({ orgId: org.orgId, bucket, key: "b.txt", bodyBuffer: Buffer.from("b"), actorEmail: "sqa" });
  assert.notEqual((await getBucketVersioning({ orgId: org.orgId, bucket })).versioningStatus, "Enabled");
});

test("a new NAS share gets a daily snapshot schedule (14 kept, immutable 7 days) and a nightly off-site backup", { timeout: 240000 }, async () => {
  appliance = await fx.makeAppliance(org, "Defaults NAS");
  mgr = await fx.provisionUser(org, org.manager, appliance._id);
  const shareName = fx.tag("dflt"); fx.created.shares.add(shareName);
  const s = await createShare({ ...M(), applianceId: String(appliance._id), shareName, ownerUnixUser: mgr.unix });
  assert.ok(!s.error, s.error);
  const p = await getSnapshotPolicy({ ...M(), shareId: String(s.share._id) });
  const policy = p.policy || p;
  assert.equal(policy.intervalMinutes, DEFAULT_NAS_SNAPSHOT_POLICY.intervalMinutes);
  assert.equal(policy.keepLast, 14);
  assert.equal(policy.immutable, true);
  assert.equal(policy.retentionDays, 7);
  assert.equal(policy.enabled, true);
  const b = (await getBackupPolicy({ ...M(), shareId: String(s.share._id) })).policy;
  assert.equal(b.intervalMinutes, DEFAULT_NAS_BACKUP_POLICY.intervalMinutes);
  assert.equal(b.keepRecoveryPoints, 14);
  assert.deepEqual(b.targetIds, ["inaya"]);
  assert.equal(b.enabled, true);
});

test("backfill: existing buckets and shares get the same protection; a company's own choices are never overridden", { timeout: 240000 }, async () => {
  // Existing state from before the defaults: a never-versioned bucket, a bucket the company Suspended, a share with no policies.
  process.env.S3_DEFAULT_VERSIONING = "off"; process.env.NAS_DEFAULT_SNAPSHOTS = "off"; process.env.NAS_DEFAULT_OFFSITE_BACKUP = "off"; process.env.S3_DEFAULT_TRIPWIRE = "off";
  const old = `old-${randomBytes(3).toString("hex")}`; const chosen = `chosen-${randomBytes(3).toString("hex")}`;
  await putS3Object({ orgId: org.orgId, bucket: old, key: "a.txt", bodyBuffer: Buffer.from("a"), actorEmail: "sqa" });
  await putS3Object({ orgId: org.orgId, bucket: chosen, key: "a.txt", bodyBuffer: Buffer.from("a"), actorEmail: "sqa" });
  await putBucketVersioning({ orgId: org.orgId, bucket: chosen, status: "Enabled" });
  await putBucketVersioning({ orgId: org.orgId, bucket: chosen, status: "Suspended" });
  const shareName = fx.tag("old"); fx.created.shares.add(shareName);
  const s = await createShare({ ...M(), applianceId: String(appliance._id), shareName, ownerUnixUser: mgr.unix });
  assert.ok(!s.error, s.error);
  process.env.S3_DEFAULT_VERSIONING = "on"; process.env.NAS_DEFAULT_SNAPSHOTS = "on"; process.env.NAS_DEFAULT_OFFSITE_BACKUP = "on"; process.env.S3_DEFAULT_TRIPWIRE = "on";
  assert.equal(await tripwires(old), 0);
  const shareId = String(s.share._id);

  const preview = await applyProtectionDefaults({ orgIds: [org.orgId] });
  assert.ok(preview.buckets.versioningEnabled >= 1 && preview.shares.snapshotScheduleAdded >= 1 && preview.shares.offsiteBackupAdded >= 1);
  assert.equal((await getBucketVersioning({ orgId: org.orgId, bucket: old })).versioningStatus, "Unversioned", "a preview changes nothing");
  assert.equal((await getSnapshotPolicy({ ...M(), shareId })).policy, null);

  const applied = await applyProtectionDefaults({ orgIds: [org.orgId], apply: true });
  assert.deepEqual(applied.shares.errors, []);
  assert.equal((await getBucketVersioning({ orgId: org.orgId, bucket: old })).versioningStatus, "Enabled");
  assert.equal((await getLifecyclePolicy({ orgId: org.orgId, bucket: old })).rules[0].noncurrentVersionExpirationDays, NONCURRENT_VERSION_DAYS);
  assert.equal((await getBucketVersioning({ orgId: org.orgId, bucket: chosen })).versioningStatus, "Suspended", "the company's choice is kept");
  const sp = (await getSnapshotPolicy({ ...M(), shareId })).policy;
  assert.equal(sp.immutable, true); assert.equal(sp.keepLast, 14);
  assert.equal((await getBackupPolicy({ ...M(), shareId })).policy.enabled, true);
  assert.equal(await tripwires(old), 1, "an existing bucket gets a tripwire");

  const again = await applyProtectionDefaults({ orgIds: [org.orgId], apply: true });
  assert.equal(again.buckets.versioningEnabled, 0); assert.equal(again.shares.snapshotScheduleAdded, 0); assert.equal(again.shares.offsiteBackupAdded, 0); assert.equal(again.buckets.tripwirePlaced, 0);
});

async function tripwires(bucket) {
  const { orgDocuments } = await getOrgCollections(); const b = await getS3Bucket({ orgId: org.orgId, bucket });
  return orgDocuments.countDocuments({ orgId: b.orgId, projectId: b._id, filename: /^\.inaya-canary\//, deletedAt: null });
}

test("a new bucket gets a hidden tripwire; it does not stop the company deleting an empty bucket", { timeout: 120000 }, async () => {
  const bucket = `trip-${randomBytes(3).toString("hex")}`;
  await putS3Object({ orgId: org.orgId, bucket, key: "a.txt", bodyBuffer: Buffer.from("a"), actorEmail: "sqa" });
  assert.equal(await tripwires(bucket), 1);
  assert.equal((await deleteS3Bucket({ orgId: org.orgId, bucket })).reason, "BucketNotEmpty", "a real file still blocks deletion");
  const { orgDocuments } = await getOrgCollections(); const b = await getS3Bucket({ orgId: org.orgId, bucket });
  await orgDocuments.deleteMany({ projectId: b._id, filename: "a.txt" }); // the company empties the bucket (all versions)
  assert.equal((await deleteS3Bucket({ orgId: org.orgId, bucket })).deleted, true);
  assert.equal(await orgDocuments.countDocuments({ projectId: b._id }), 0, "the tripwire went with the bucket");
});

test("tripwire scoring: rewriting one pauses the account (CRITICAL); deleting one only alerts (HIGH), because mirror-sync tools delete too", () => {
  assert.equal(classifyCloudThreat({ canaryTouched: 1 }).level, "CRITICAL");
  const del = classifyCloudThreat({ canaryDeleted: 1 });
  assert.equal(del.level, "HIGH"); assert.deepEqual(del.rules, ["canary_deleted"]);
});
