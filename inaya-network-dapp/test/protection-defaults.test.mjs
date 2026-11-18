// test/protection-defaults.test.mjs -- ransomware protection on by default (src/lib/protectionDefaults.js, 17 Nov 2026):
// new S3-compatible buckets are versioned with a 30-day old-version lifecycle rule; new NAS shares get a daily, immutable
// snapshot schedule. Existing buckets are left alone. Runs against the test database and the real NAS appliance VM.
process.env.S3_DEFAULT_VERSIONING = "on";
process.env.NAS_DEFAULT_SNAPSHOTS = "on";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import * as fx from "./_nas-fixtures.mjs";
import { installMemoryProviders } from "./_docauto-fixtures.mjs";
import { putS3Object, getS3ObjectBody, getBucketVersioning, getLifecyclePolicy } from "../src/lib/s3-compat/store.js";
import { ensureOwnerS3Passphrase } from "../src/lib/s3-compat/credentials.js";
import { createShare } from "../src/lib/nas/shares.js";
import { getSnapshotPolicy } from "../src/lib/nas/snapshots.js";
import { NONCURRENT_VERSION_DAYS, DEFAULT_NAS_SNAPSHOT_POLICY } from "../src/lib/protectionDefaults.js";

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

test("a new NAS share gets a daily snapshot schedule: 14 kept, each immutable for 7 days", { timeout: 240000 }, async () => {
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
});
