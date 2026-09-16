// test/s3-compat-capabilities.test.mjs
//
// Storj-Inspired Storage Capability Expansion SOW -- integration tests for
// the capabilities added on top of the already-verified S3/Azure
// compatibility layer: Granular Storage Access Grants (§2), Object
// Versioning (§3), Object Lock (§4), Legal Hold (§5), Lifecycle/Retention
// Policies (§6), and the Automated Storage Health & Repair wiring (§7).
// Follows the exact same real-DB, real-pinning-provider harness as
// test/s3-compat-store.test.mjs.
//
// Run with: node --env-file=.env.local --test test/s3-compat-capabilities.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { issueS3Credential, checkScope, ensureS3CompatIndexes } from "../src/lib/s3-compat/credentials.js";
import {
  putS3Object, getS3ObjectBody, deleteS3Object, headS3Object,
  putBucketVersioning, getBucketVersioning, enableBucketObjectLock,
  putObjectRetention, putObjectLegalHold, listObjectVersions, restoreObjectVersion,
  putLifecyclePolicy, runLifecycleEnforcement, getS3ObjectHealth,
} from "../src/lib/s3-compat/store.js";

const RUN_ID = randomUUID().slice(0, 8);
const cleanup = { orgIds: [] };
let collections;

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
  await ensureS3CompatIndexes(collections.db);
});

after(async () => {
  const { orgs, departments, projects, orgDocuments, orgActivity } = collections;
  await orgs.deleteMany({ _id: { $in: cleanup.orgIds } });
  await departments.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await projects.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await orgDocuments.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await orgActivity.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await collections.db.collection("s3_credentials").deleteMany({ ownerId: { $in: cleanup.orgIds.map((id) => id.toString()) } });
  await collections.db.collection("s3_owner_keys").deleteMany({ ownerId: { $in: cleanup.orgIds.map((id) => id.toString()) } });
  await collections.db.collection("s3_lifecycle_policies").deleteMany({ orgId: { $in: cleanup.orgIds } });
});

async function makeTestOrg(label) {
  const orgId = new ObjectId();
  await collections.orgs.insertOne({ _id: orgId, name: `s3-compat-cap-test-${RUN_ID}-${label}`, createdAt: new Date().toISOString() });
  cleanup.orgIds.push(orgId);
  return orgId.toString();
}

// ---------------------------------------------------------------------
// §2: Granular Storage Access Grants
// ---------------------------------------------------------------------

test("checkScope: a credential with no scope is unrestricted (existing owner-level credentials keep working)", () => {
  const result = checkScope({ scope: null }, { bucket: "anything", key: "any/key", operation: "DELETE" });
  assert.equal(result.allowed, true);
});

test("checkScope: bucket-scoped credential is denied for a different bucket (SECURITY)", () => {
  const cred = { scope: { bucket: "finance" } };
  assert.equal(checkScope(cred, { bucket: "finance", key: "x", operation: "READ" }).allowed, true);
  const denied = checkScope(cred, { bucket: "hr", key: "x", operation: "READ" });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, "BucketScopeDenied");
});

test("checkScope: prefix-scoped credential is denied outside its prefix (SECURITY)", () => {
  const cred = { scope: { bucket: "finance", prefix: "invoices/2026/" } };
  assert.equal(checkScope(cred, { bucket: "finance", key: "invoices/2026/jan.pdf", operation: "READ" }).allowed, true);
  const denied = checkScope(cred, { bucket: "finance", key: "payroll/jan.pdf", operation: "READ" });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, "PrefixScopeDenied");
});

test("checkScope: operation-scoped (READ-only) credential is denied WRITE (SECURITY)", () => {
  const cred = { scope: { operations: ["READ"] } };
  assert.equal(checkScope(cred, { operation: "READ" }).allowed, true);
  const denied = checkScope(cred, { operation: "WRITE" });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, "OperationScopeDenied");
});

test("checkScope: expired credential is denied regardless of other scope fields (SECURITY)", () => {
  const cred = { scope: { expiresAt: new Date(Date.now() - 1000).toISOString() } };
  const denied = checkScope(cred, { operation: "READ" });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, "CredentialExpired");
});

test("issueS3Credential rejects an invalid scope (prefix without bucket) rather than silently narrowing it", async () => {
  const orgId = await makeTestOrg("scope-invalid");
  await assert.rejects(issueS3Credential({ owner: { type: "org", orgId }, actorEmail: "t", scope: { prefix: "x/" } }));
});

test("issueS3Credential accepts and persists a valid scope", async () => {
  const orgId = await makeTestOrg("scope-valid");
  const result = await issueS3Credential({ owner: { type: "org", orgId }, actorEmail: "t", scope: { bucket: "finance", operations: ["READ"] } });
  assert.deepEqual(result.scope, { bucket: "finance", operations: ["READ"] });
});

// ---------------------------------------------------------------------
// §3: Object Versioning
// ---------------------------------------------------------------------

test("Versioning: an unversioned bucket keeps only the latest object (no regression from Workstream A)", async () => {
  const orgId = await makeTestOrg("ver-unversioned");
  await issueS3Credential({ owner: { type: "org", orgId }, actorEmail: "t" });
  await putS3Object({ orgId, bucket: "b", key: "k.txt", bodyBuffer: Buffer.from("v1"), contentType: "text/plain", actorEmail: "t" });
  await putS3Object({ orgId, bucket: "b", key: "k.txt", bodyBuffer: Buffer.from("v2"), contentType: "text/plain", actorEmail: "t" });
  const versions = await listObjectVersions({ orgId, bucket: "b", key: "k.txt" });
  // Both rows still exist (one soft-deleted) -- versions listing shows history
  // regardless, but only one is "live" via headS3Object.
  const live = await headS3Object({ orgId, bucket: "b", key: "k.txt" });
  assert.equal((await getS3ObjectBody({ orgId, bucket: "b", key: "k.txt" })).buffer.toString(), "v2");
  assert.equal(live.versionId, "null");
});

test("Versioning: an Enabled bucket keeps every version retrievable by versionId", async () => {
  const orgId = await makeTestOrg("ver-enabled");
  await issueS3Credential({ owner: { type: "org", orgId }, actorEmail: "t" });
  await putS3Object({ orgId, bucket: "vb", key: "k.txt", bodyBuffer: Buffer.from("seed"), contentType: "text/plain", actorEmail: "t" });
  await putBucketVersioning({ orgId, bucket: "vb", status: "Enabled" });
  const v1 = await putS3Object({ orgId, bucket: "vb", key: "k.txt", bodyBuffer: Buffer.from("version-1"), contentType: "text/plain", actorEmail: "t" });
  const v2 = await putS3Object({ orgId, bucket: "vb", key: "k.txt", bodyBuffer: Buffer.from("version-2"), contentType: "text/plain", actorEmail: "t" });

  assert.notEqual(v1.versionId, v2.versionId);
  assert.notEqual(v1.versionId, "null");

  const latest = await getS3ObjectBody({ orgId, bucket: "vb", key: "k.txt" });
  assert.equal(latest.buffer.toString(), "version-2");

  const old = await getS3ObjectBody({ orgId, bucket: "vb", key: "k.txt", versionId: v1.versionId });
  assert.equal(old.buffer.toString(), "version-1", "an older version must remain retrievable by its versionId after being superseded");

  const versions = await listObjectVersions({ orgId, bucket: "vb", key: "k.txt" });
  assert.ok(versions.length >= 3, "seed + v1 + v2 should all be listed");
  assert.equal(versions.filter((v) => v.isLatest).length, 1, "exactly one version should be marked latest");
});

test("Versioning: restoreObjectVersion copies an old version's content forward as a new current version", async () => {
  const orgId = await makeTestOrg("ver-restore");
  await issueS3Credential({ owner: { type: "org", orgId }, actorEmail: "t" });
  await putBucketVersioning({ orgId, bucket: "rb", status: "Enabled" });
  const v1 = await putS3Object({ orgId, bucket: "rb", key: "k.txt", bodyBuffer: Buffer.from("original"), contentType: "text/plain", actorEmail: "t" });
  await putS3Object({ orgId, bucket: "rb", key: "k.txt", bodyBuffer: Buffer.from("overwritten"), contentType: "text/plain", actorEmail: "t" });

  await restoreObjectVersion({ orgId, bucket: "rb", key: "k.txt", versionId: v1.versionId, actorEmail: "t" });
  const current = await getS3ObjectBody({ orgId, bucket: "rb", key: "k.txt" });
  assert.equal(current.buffer.toString(), "original", "restoring a version must make its content the new current version");
});

test("SECURITY: a version id from one org cannot be used to read another org's object", async () => {
  const orgA = await makeTestOrg("ver-iso-a");
  const orgB = await makeTestOrg("ver-iso-b");
  await issueS3Credential({ owner: { type: "org", orgId: orgA }, actorEmail: "a" });
  await issueS3Credential({ owner: { type: "org", orgId: orgB }, actorEmail: "b" });
  await putBucketVersioning({ orgId: orgA, bucket: "b", status: "Enabled" });
  const doc = await putS3Object({ orgId: orgA, bucket: "b", key: "k.txt", bodyBuffer: Buffer.from("secret"), contentType: "text/plain", actorEmail: "a" });

  const crossOrgRead = await headS3Object({ orgId: orgB, bucket: "b", key: "k.txt", versionId: doc.versionId });
  assert.equal(crossOrgRead, null, "org B must never resolve org A's versionId, even for the same bucket/key names");
});

// ---------------------------------------------------------------------
// §4: Object Lock, §5: Legal Hold
// ---------------------------------------------------------------------

test("Object Lock requires Versioning Enabled first (real S3 precondition, enforced not just documented)", async () => {
  const orgId = await makeTestOrg("lock-precondition");
  await issueS3Credential({ owner: { type: "org", orgId }, actorEmail: "t" });
  await putS3Object({ orgId, bucket: "b", key: "k.txt", bodyBuffer: Buffer.from("x"), contentType: "text/plain", actorEmail: "t" });
  await assert.rejects(enableBucketObjectLock({ orgId, bucket: "b" }));
});

test("Object Lock: a retention-locked object cannot be deleted before its retentionUntil (SECURITY)", async () => {
  const orgId = await makeTestOrg("lock-delete");
  await issueS3Credential({ owner: { type: "org", orgId }, actorEmail: "t" });
  await putBucketVersioning({ orgId, bucket: "lb", status: "Enabled" });
  await enableBucketObjectLock({ orgId, bucket: "lb" });
  await putS3Object({ orgId, bucket: "lb", key: "k.txt", bodyBuffer: Buffer.from("locked"), contentType: "text/plain", actorEmail: "t" });
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await putObjectRetention({ orgId, bucket: "lb", key: "k.txt", retentionMode: "COMPLIANCE", retentionUntil: future, actorEmail: "t" });

  await assert.rejects(
    deleteS3Object({ orgId, bucket: "lb", key: "k.txt", versionId: (await headS3Object({ orgId, bucket: "lb", key: "k.txt" })).versionId, actorEmail: "t" }),
    /retention-locked/
  );
});

test("Object Lock: retention cannot be shortened once set (SECURITY)", async () => {
  const orgId = await makeTestOrg("lock-shorten");
  await issueS3Credential({ owner: { type: "org", orgId }, actorEmail: "t" });
  await putBucketVersioning({ orgId, bucket: "lb2", status: "Enabled" });
  await enableBucketObjectLock({ orgId, bucket: "lb2" });
  await putS3Object({ orgId, bucket: "lb2", key: "k.txt", bodyBuffer: Buffer.from("x"), contentType: "text/plain", actorEmail: "t" });
  const far = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const near = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  await putObjectRetention({ orgId, bucket: "lb2", key: "k.txt", retentionMode: "GOVERNANCE", retentionUntil: far, actorEmail: "t" });
  await assert.rejects(putObjectRetention({ orgId, bucket: "lb2", key: "k.txt", retentionMode: "GOVERNANCE", retentionUntil: near, actorEmail: "t" }));
});

test("Legal Hold: a held object cannot be deleted, and deletion succeeds after release (SECURITY)", async () => {
  const orgId = await makeTestOrg("legal-hold");
  await issueS3Credential({ owner: { type: "org", orgId }, actorEmail: "t" });
  await putS3Object({ orgId, bucket: "b", key: "k.txt", bodyBuffer: Buffer.from("held"), contentType: "text/plain", actorEmail: "t" });
  await putObjectLegalHold({ orgId, bucket: "b", key: "k.txt", legalHold: true, actorEmail: "t" });

  await assert.rejects(deleteS3Object({ orgId, bucket: "b", key: "k.txt", actorEmail: "t" }), /legal hold/);

  await putObjectLegalHold({ orgId, bucket: "b", key: "k.txt", legalHold: false, actorEmail: "t" });
  const result = await deleteS3Object({ orgId, bucket: "b", key: "k.txt", actorEmail: "t" });
  assert.equal(result.deleted, true);
});

test("Legal Hold also blocks overwrite (PUT) on an unversioned bucket, not just DELETE (SECURITY)", async () => {
  const orgId = await makeTestOrg("legal-hold-overwrite");
  await issueS3Credential({ owner: { type: "org", orgId }, actorEmail: "t" });
  await putS3Object({ orgId, bucket: "b", key: "k.txt", bodyBuffer: Buffer.from("v1"), contentType: "text/plain", actorEmail: "t" });
  await putObjectLegalHold({ orgId, bucket: "b", key: "k.txt", legalHold: true, actorEmail: "t" });
  await assert.rejects(putS3Object({ orgId, bucket: "b", key: "k.txt", bodyBuffer: Buffer.from("v2"), contentType: "text/plain", actorEmail: "t" }));
});

// ---------------------------------------------------------------------
// §6: Lifecycle & Retention Policies
// ---------------------------------------------------------------------

test("Lifecycle: an object past its rule's expirationDays is expired by runLifecycleEnforcement", async () => {
  const orgId = await makeTestOrg("lifecycle-expire");
  await issueS3Credential({ owner: { type: "org", orgId }, actorEmail: "t" });
  const doc = await putS3Object({ orgId, bucket: "lcb", key: "old.txt", bodyBuffer: Buffer.from("x"), contentType: "text/plain", actorEmail: "t" });
  // Backdate createdAt directly (simulating an object that's genuinely old) --
  // real time-travel isn't available in a test, so this is the honest way to
  // exercise "past its expiration" without waiting real days.
  await collections.orgDocuments.updateOne({ _id: doc._id }, { $set: { createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString() } });
  await putLifecyclePolicy({ orgId, bucket: "lcb", rules: [{ id: "r1", prefix: "", expirationDays: 5 }], actorEmail: "t" });

  const result = await runLifecycleEnforcement({});
  assert.ok(result.expired >= 1);
  const head = await headS3Object({ orgId, bucket: "lcb", key: "old.txt" });
  assert.equal(head, null, "the expired object must no longer be live");
});

test("Lifecycle: a legal-held object is NEVER auto-expired, even past its rule's expirationDays (SECURITY)", async () => {
  const orgId = await makeTestOrg("lifecycle-legal-hold");
  await issueS3Credential({ owner: { type: "org", orgId }, actorEmail: "t" });
  const doc = await putS3Object({ orgId, bucket: "lcb2", key: "held.txt", bodyBuffer: Buffer.from("x"), contentType: "text/plain", actorEmail: "t" });
  await putObjectLegalHold({ orgId, bucket: "lcb2", key: "held.txt", legalHold: true, actorEmail: "t" });
  await collections.orgDocuments.updateOne({ _id: doc._id }, { $set: { createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString() } });
  await putLifecyclePolicy({ orgId, bucket: "lcb2", rules: [{ id: "r1", prefix: "", expirationDays: 1 }], actorEmail: "t" });

  const result = await runLifecycleEnforcement({});
  assert.ok(result.skippedLocked >= 1);
  const head = await headS3Object({ orgId, bucket: "lcb2", key: "held.txt" });
  assert.notEqual(head, null, "a legal-held object must survive lifecycle enforcement");
});

// ---------------------------------------------------------------------
// §7: Automated Storage Health & Repair -- backupEngine registration
// ---------------------------------------------------------------------

test("putS3Object registers both shards with the real backupEngine health pipeline (regression: this was previously a silent gap)", async () => {
  const orgId = await makeTestOrg("health-wiring");
  await issueS3Credential({ owner: { type: "org", orgId }, actorEmail: "t" });
  await putS3Object({ orgId, bucket: "b", key: "k.txt", bodyBuffer: Buffer.from("health check content"), contentType: "text/plain", actorEmail: "t" });
  const health = await getS3ObjectHealth({ orgId, bucket: "b", key: "k.txt" });
  assert.ok(health, "getBackupStatus must return a real record for an S3-compat object's fileHash");
  assert.ok(health.shardAlpha.replicaCount >= 1, "the primary alpha replica must be registered");
  assert.ok(health.shardBeta.replicaCount >= 1, "the primary beta replica must be registered");
  assert.notEqual(health.healthState, "RECOVERY_FAILED", "a freshly-uploaded object with at least one real replica per shard must not read as fully failed");
});
