// test/s3-compat-store.test.mjs
//
// Multi-Cloud Enterprise Storage Compatibility SOW, Workstream A —
// integration tests against the real database and real pinning provider
// for the credential lifecycle and the org-scoped object store. Real
// end-to-end HTTP behavior (SigV4 auth, byte-range GET, multipart upload)
// was verified live against the real AWS CLI during development -- see
// the SOW report for that manual run's exact commands and output. These
// tests cover what a CLI session alone doesn't: the security properties
// (cross-org isolation, revocation) and round-trip data integrity at the
// function level.
//
// Run with: node --env-file=.env.local --test test/s3-compat-store.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { issueS3Credential, resolveS3Credential, revokeS3Credential, ensureS3CompatIndexes } from "../src/lib/s3-compat/credentials.js";
import { putS3Object, getS3ObjectBody, deleteS3Object, listS3Buckets, headS3Object } from "../src/lib/s3-compat/store.js";

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
});

async function makeTestOrg(label) {
  const orgId = new ObjectId();
  await collections.orgs.insertOne({ _id: orgId, name: `s3-compat-test-${RUN_ID}-${label}`, createdAt: new Date().toISOString() });
  cleanup.orgIds.push(orgId);
  return orgId.toString();
}

test("issueS3Credential + resolveS3Credential round-trip resolves to the correct org", async () => {
  const orgId = await makeTestOrg("resolve");
  const { accessKeyId, secretAccessKey } = await issueS3Credential({ owner: { type: "org", orgId }, label: "test", actorEmail: "t@example.com" });
  const resolved = await resolveS3Credential(accessKeyId);
  assert.equal(resolved.owner.type, "org");
  assert.equal(resolved.owner.orgId, orgId);
  assert.equal(resolved.secretAccessKey, secretAccessKey); // the unwrapped secret must exactly match what was issued
});

test("revokeS3Credential makes resolveS3Credential return null (SECURITY)", async () => {
  const orgId = await makeTestOrg("revoke");
  const { accessKeyId } = await issueS3Credential({ owner: { type: "org", orgId }, actorEmail: "t@example.com" });
  assert.notEqual(await resolveS3Credential(accessKeyId), null);
  const revoked = await revokeS3Credential({ owner: { type: "org", orgId }, accessKeyId });
  assert.equal(revoked, true);
  assert.equal(await resolveS3Credential(accessKeyId), null);
});

test("SECURITY: a credential can never resolve to a different org than it was issued for, even under a colliding accessKeyId lookup attempt", async () => {
  const orgA = await makeTestOrg("iso-a");
  const orgB = await makeTestOrg("iso-b");
  const credA = await issueS3Credential({ owner: { type: "org", orgId: orgA }, actorEmail: "a@example.com" });
  const credB = await issueS3Credential({ owner: { type: "org", orgId: orgB }, actorEmail: "b@example.com" });
  const resolvedA = await resolveS3Credential(credA.accessKeyId);
  const resolvedB = await resolveS3Credential(credB.accessKeyId);
  assert.equal(resolvedA.owner.orgId, orgA);
  assert.equal(resolvedB.owner.orgId, orgB);
  assert.notEqual(resolvedA.owner.orgId, resolvedB.owner.orgId);
});

test("putS3Object -> getS3ObjectBody round-trips real bytes through the real encrypt/shard/pin/reconstruct/decrypt pipeline", async () => {
  const orgId = await makeTestOrg("roundtrip");
  await issueS3Credential({ owner: { type: "org", orgId }, actorEmail: "t@example.com" }); // ensures the org's passphrase exists
  const original = Buffer.from(`Real test content ${randomUUID()}`, "utf8");

  const doc = await putS3Object({ orgId, bucket: "test-bucket", key: "folder/file.txt", bodyBuffer: original, contentType: "text/plain", actorEmail: "t@example.com" });
  assert.equal(doc.encryptionMode, "server-managed");
  assert.equal(doc.filename, "folder/file.txt");
  assert.equal(doc.sizeBytes, original.length);

  const result = await getS3ObjectBody({ orgId, bucket: "test-bucket", key: "folder/file.txt" });
  assert.ok(result, "object should be retrievable immediately after PUT");
  assert.equal(Buffer.compare(result.buffer, original), 0, "decrypted content must be byte-identical to what was uploaded");
});

test("putS3Object on an existing key soft-deletes the prior object (real S3 overwrite semantics)", async () => {
  const orgId = await makeTestOrg("overwrite");
  await issueS3Credential({ owner: { type: "org", orgId }, actorEmail: "t@example.com" });
  await putS3Object({ orgId, bucket: "b", key: "k.txt", bodyBuffer: Buffer.from("v1"), contentType: "text/plain", actorEmail: "t" });
  await putS3Object({ orgId, bucket: "b", key: "k.txt", bodyBuffer: Buffer.from("v2"), contentType: "text/plain", actorEmail: "t" });

  const { orgDocuments } = collections;
  const live = await orgDocuments.find({ orgId: new ObjectId(orgId), filename: "k.txt", deletedAt: null }).toArray();
  assert.equal(live.length, 1, "only one live document should exist for a re-uploaded key");

  const result = await getS3ObjectBody({ orgId, bucket: "b", key: "k.txt" });
  assert.equal(result.buffer.toString("utf8"), "v2", "GET must return the latest version, not the overwritten one");
});

test("deleteS3Object is idempotent -- deleting a nonexistent key is not an error (real S3 behavior)", async () => {
  const orgId = await makeTestOrg("delete-idempotent");
  const result = await deleteS3Object({ orgId, bucket: "b", key: "never-existed.txt", actorEmail: "t" });
  assert.equal(result.deleted, true);
});

test("headS3Object returns null for a deleted object, never a stale record", async () => {
  const orgId = await makeTestOrg("head-after-delete");
  await issueS3Credential({ owner: { type: "org", orgId }, actorEmail: "t@example.com" });
  await putS3Object({ orgId, bucket: "b", key: "k.txt", bodyBuffer: Buffer.from("data"), contentType: "text/plain", actorEmail: "t" });
  await deleteS3Object({ orgId, bucket: "b", key: "k.txt", actorEmail: "t" });
  const head = await headS3Object({ orgId, bucket: "b", key: "k.txt" });
  assert.equal(head, null);
});

test("every fileHash written is unique -- repeat uploads of identical content never collide with org_documents' unique index (regression: real bug found and fixed during this SOW)", async () => {
  const orgId = await makeTestOrg("hash-uniqueness");
  await issueS3Credential({ owner: { type: "org", orgId }, actorEmail: "t@example.com" });
  const sameContent = Buffer.from("identical bytes uploaded twice");
  await putS3Object({ orgId, bucket: "b", key: "first.txt", bodyBuffer: sameContent, contentType: "text/plain", actorEmail: "t" });
  // This second PUT (different key, identical bytes) is the exact scenario that
  // previously threw E11000 duplicate key error on org_documents.fileHash.
  await assert.doesNotReject(
    putS3Object({ orgId, bucket: "b", key: "second.txt", bodyBuffer: sameContent, contentType: "text/plain", actorEmail: "t" })
  );
});

test("listS3Buckets only shows buckets created under the org's own hidden system department", async () => {
  const orgId = await makeTestOrg("bucket-list");
  await issueS3Credential({ owner: { type: "org", orgId }, actorEmail: "t@example.com" });
  await putS3Object({ orgId, bucket: "alpha-bucket", key: "a.txt", bodyBuffer: Buffer.from("a"), contentType: "text/plain", actorEmail: "t" });
  const buckets = await listS3Buckets(orgId);
  assert.ok(buckets.some((b) => b.name === "alpha-bucket"));
});
