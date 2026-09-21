// test/s3-compat-expansion.test.mjs
//
// AWS S3 Feature Expansion SOW — Object Tags, checksum, Inventory, Batch
// Operations, Storage Analytics, and the read-only Policy Analyzer. All
// against the real database and real pinning provider, same convention as
// test/s3-compat-store.test.mjs.
//
// Run with: node --env-file=.env.local --test test/s3-compat-expansion.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import mongoClientPromise from "../src/lib/mongodb.js";
import { ensureS3CompatIndexes, issueS3Credential } from "../src/lib/s3-compat/credentials.js";
import { putS3Object, putObjectTagging, getObjectTagging, deleteObjectTagging, putObjectRetention, putBucketVersioning, enableBucketObjectLock } from "../src/lib/s3-compat/store.js";
import { buildStorageInventory, renderInventoryCsv } from "../src/lib/s3-compat/inventory.js";
import { runBatchOperation } from "../src/lib/s3-compat/batchOperations.js";
import { computeS3BucketAnalytics } from "../src/lib/s3-compat/analytics.js";
import { analyzeS3CredentialPolicies } from "../src/lib/s3-compat/policyAnalyzer.js";

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
  const client = await mongoClientPromise;
  await client.close();
});

// issueS3Credential() is what lazily creates the owner's S3-compatibility
// passphrase (ensureOwnerS3Passphrase, credentials.js) -- putS3Object()
// throws without it. Every existing s3-compat test file issues one first
// for exactly this reason (see s3-compat-store.test.mjs's own "ensures
// the org's passphrase exists" comment); this test file needs the same.
async function makeTestOrg(label) {
  const orgId = new ObjectId();
  await collections.orgs.insertOne({ _id: orgId, name: `s3-expansion-test-${RUN_ID}-${label}`, createdAt: new Date().toISOString() });
  cleanup.orgIds.push(orgId);
  await issueS3Credential({ owner: { type: "org", orgId }, actorEmail: "t@example.com" });
  return orgId.toString();
}

test("putS3Object computes a real, independently-verifiable contentSha256, distinct from the salted fileHash", async () => {
  const orgId = await makeTestOrg("checksum");
  const bytes = Buffer.from("checksum me");
  const doc = await putS3Object({ orgId, bucket: "b", key: "k.txt", bodyBuffer: bytes, contentType: "text/plain", actorEmail: "t" });

  const realHash = createHash("sha256").update(bytes).digest("hex");
  assert.equal(doc.contentSha256, realHash, "contentSha256 must be a plain, unsalted hash of the real bytes");
  assert.notEqual(doc.fileHash, doc.contentSha256, "fileHash (salted for dedup) and contentSha256 (real checksum) must be different values");
});

test("object tagging: put/get/delete round-trip, validated and audited", async () => {
  const orgId = await makeTestOrg("tags");
  await putS3Object({ orgId, bucket: "b", key: "k.txt", bodyBuffer: Buffer.from("x"), contentType: "text/plain", actorEmail: "t" });

  const put = await putObjectTagging({ orgId, bucket: "b", key: "k.txt", tags: { env: "prod", team: "finance" }, actorEmail: "t" });
  assert.deepEqual(put.tags, { env: "prod", team: "finance" });

  const got = await getObjectTagging({ orgId, bucket: "b", key: "k.txt" });
  assert.deepEqual(got.tags, { env: "prod", team: "finance" });

  await deleteObjectTagging({ orgId, bucket: "b", key: "k.txt", actorEmail: "t" });
  const afterDelete = await getObjectTagging({ orgId, bucket: "b", key: "k.txt" });
  assert.deepEqual(afterDelete.tags, {});

  const auditRow = await collections.orgActivity.findOne({ orgId: new ObjectId(orgId), recordType: "s3_object", action: "OBJECT_TAGS_SET" });
  assert.ok(auditRow, "tagging must be audited through the existing activity/audit chain");
});

test("object tagging rejects more than 10 tags and overlength keys/values (real S3 limits)", async () => {
  const orgId = await makeTestOrg("tags-limits");
  await putS3Object({ orgId, bucket: "b", key: "k.txt", bodyBuffer: Buffer.from("x"), contentType: "text/plain", actorEmail: "t" });

  const tooMany = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, "v"]));
  await assert.rejects(() => putObjectTagging({ orgId, bucket: "b", key: "k.txt", tags: tooMany, actorEmail: "t" }), /maximum of 10 tags/);

  await assert.rejects(() => putObjectTagging({ orgId, bucket: "b", key: "k.txt", tags: { ok: "x".repeat(300) }, actorEmail: "t" }), /Invalid tag value/);
});

test("a batch tag operation reports per-key success/failure and never fails the whole job for one bad key", async () => {
  const orgId = await makeTestOrg("batch-mixed");
  await putS3Object({ orgId, bucket: "b", key: "a.txt", bodyBuffer: Buffer.from("a"), contentType: "text/plain", actorEmail: "t" });
  await putS3Object({ orgId, bucket: "b", key: "b.txt", bodyBuffer: Buffer.from("b"), contentType: "text/plain", actorEmail: "t" });

  const result = await runBatchOperation({ orgId, bucket: "b", keys: ["a.txt", "b.txt", "missing.txt"], operation: "SET_TAGS", params: { tags: { batch: "1" } }, actorEmail: "t" });
  assert.equal(result.totalKeys, 3);
  assert.equal(result.succeeded, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.results.find((r) => r.key === "missing.txt").status, "FAILED");
  assert.equal(result.results.find((r) => r.key === "a.txt").status, "SUCCEEDED");

  const tagged = await getObjectTagging({ orgId, bucket: "b", key: "a.txt" });
  assert.deepEqual(tagged.tags, { batch: "1" });
});

test("a batch retention operation cannot bypass Object Lock/Legal Hold — a locked object fails as a normal per-key result, not a job crash (SECURITY)", async () => {
  const orgId = await makeTestOrg("batch-lock");
  await putBucketVersioning({ orgId, bucket: "b", status: "Enabled" });
  await enableBucketObjectLock({ orgId, bucket: "b" });
  await putS3Object({ orgId, bucket: "b", key: "locked.txt", bodyBuffer: Buffer.from("x"), contentType: "text/plain", actorEmail: "t" });
  await putS3Object({ orgId, bucket: "b", key: "open.txt", bodyBuffer: Buffer.from("y"), contentType: "text/plain", actorEmail: "t" });

  // Batch-applying a SHORTER retention than one object already has must
  // fail for that one key (putObjectRetention's own "never shorten" rule)
  // without touching the other key.
  const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await putObjectRetention({ orgId, bucket: "b", key: "locked.txt", retentionMode: "COMPLIANCE", retentionUntil: future, actorEmail: "t" });

  const past = new Date(Date.now() + 1000).toISOString(); // earlier than `future`, but still valid/future-only for the fresh key
  const result = await runBatchOperation({
    orgId, bucket: "b", keys: ["locked.txt", "open.txt"], operation: "SET_RETENTION",
    params: { retentionMode: "COMPLIANCE", retentionUntil: past }, actorEmail: "t",
  });
  assert.equal(result.results.find((r) => r.key === "locked.txt").status, "FAILED", "shortening an existing retention period must fail this key, not the whole job");
  assert.equal(result.results.find((r) => r.key === "open.txt").status, "SUCCEEDED", "an unrelated key in the same batch must still succeed");
});

test("a batch job is capped at 1000 keys per request", async () => {
  const orgId = await makeTestOrg("batch-cap");
  const keys = Array.from({ length: 1001 }, (_, i) => `k${i}.txt`);
  await assert.rejects(() => runBatchOperation({ orgId, bucket: "b", keys, operation: "SET_TAGS", params: { tags: {} }, actorEmail: "t" }), /limited to 1000 keys/);
});

test("storage inventory reports real objects with their tags, checksum, and lock state, org-scoped", async () => {
  const orgA = await makeTestOrg("inv-a");
  const orgB = await makeTestOrg("inv-b");
  await putS3Object({ orgId: orgA, bucket: "b1", key: "one.txt", bodyBuffer: Buffer.from("111"), contentType: "text/plain", actorEmail: "t" });
  await putObjectTagging({ orgId: orgA, bucket: "b1", key: "one.txt", tags: { project: "alpha" }, actorEmail: "t" });
  await putS3Object({ orgId: orgB, bucket: "b1", key: "other-org.txt", bodyBuffer: Buffer.from("222"), contentType: "text/plain", actorEmail: "t" });

  const inventory = await buildStorageInventory({ orgId: orgA });
  assert.equal(inventory.objectCount, 1);
  assert.equal(inventory.objects[0].key, "one.txt");
  assert.deepEqual(inventory.objects[0].tags, { project: "alpha" });
  assert.ok(inventory.objects[0].contentSha256);
  assert.ok(!inventory.objects.some((o) => o.key === "other-org.txt"), "inventory must never include another org's objects");

  const csv = renderInventoryCsv(inventory);
  assert.match(csv, /one\.txt/);
  assert.match(csv, /project/);
});

test("storage analytics computes real per-bucket counts, sizes, and lock/legal-hold counts", async () => {
  const orgId = await makeTestOrg("analytics");
  await putS3Object({ orgId, bucket: "b", key: "small.txt", bodyBuffer: Buffer.from("12345"), contentType: "text/plain", actorEmail: "t" });
  await putS3Object({ orgId, bucket: "b", key: "large.txt", bodyBuffer: Buffer.from("1234567890"), contentType: "text/plain", actorEmail: "t" });

  const analytics = await computeS3BucketAnalytics({ orgId, bucket: "b" });
  const bucketStats = analytics.buckets.find((b) => b.bucket === "b");
  assert.equal(bucketStats.objectCount, 2);
  assert.equal(bucketStats.totalSizeBytes, 15);
  assert.equal(bucketStats.largestObjects[0].key, "large.txt");
});

test("policy analyzer flags an unscoped credential as HIGH severity and never mutates any credential (read-only)", async () => {
  const orgId = await makeTestOrg("policy"); // already issues one unlabeled, unscoped credential
  await issueS3Credential({ owner: { type: "org", orgId }, label: "scoped", actorEmail: "t", scope: { bucket: "finance", operations: ["READ"] } });

  const before = await collections.db.collection("s3_credentials").find({ ownerId: orgId }).toArray();
  const analysis = await analyzeS3CredentialPolicies({ type: "org", orgId });
  const after = await collections.db.collection("s3_credentials").find({ ownerId: orgId }).toArray();
  assert.deepEqual(after, before, "the policy analyzer must never write to s3_credentials");

  assert.equal(analysis.credentialCount, 2);
  const unrestricted = analysis.credentials.find((c) => !c.label);
  assert.ok(unrestricted.findings.some((f) => f.type === "UNRESTRICTED_CREDENTIAL" && f.severity === "HIGH"));
  const scoped = analysis.credentials.find((c) => c.label === "scoped");
  assert.ok(!scoped.findings.some((f) => f.type === "UNRESTRICTED_CREDENTIAL"));
  assert.equal(analysis.unusedCredentials, null, "unused-credential detection must be honestly reported as not computed, never a fabricated empty list");
});
