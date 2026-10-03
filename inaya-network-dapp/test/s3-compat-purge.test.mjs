// test/s3-compat-purge.test.mjs
//
// SQA R-6 -- deleting or replacing an S3-compat object must free the provider storage, not just
// hide the row. Real database and real pinning provider, same harness as s3-compat-capabilities.
//
// Run with: node --env-file=.env.local --test test/s3-compat-purge.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { ensureS3CompatIndexes, ensureOwnerS3Passphrase } from "../src/lib/s3-compat/credentials.js";
import { putS3Object, deleteS3Object, putBucketVersioning, getS3ObjectBody, listObjectVersions } from "../src/lib/s3-compat/store.js";
import { sweepPendingPurges, purgeOrgObjects } from "../src/lib/s3-compat/purge.js";
import { getProvider } from "../src/lib/pinningProviders/index.js";
import { getBackupStatus } from "../src/lib/backupEngine.js";

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
  for (const id of cleanup.orgIds) await purgeOrgObjects(id).catch(() => {});
  await orgs.deleteMany({ _id: { $in: cleanup.orgIds } });
  await departments.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await projects.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await orgDocuments.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await orgActivity.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await collections.db.collection("s3_owner_keys").deleteMany({ ownerId: { $in: cleanup.orgIds.map((id) => id.toString()) } });
});

async function makeTestOrg(label) {
  const orgId = new ObjectId();
  await collections.orgs.insertOne({ _id: orgId, name: `s3-purge-test-${RUN_ID}-${label}`, createdAt: new Date().toISOString() });
  cleanup.orgIds.push(orgId);
  await ensureOwnerS3Passphrase({ type: "org", orgId: orgId.toString() });
  return orgId.toString();
}

// backupEngine keeps its replica records in its own database, so read them through its API.
const replicaCount = async (fileHash) => {
  const status = await getBackupStatus(fileHash);
  return status.shardAlpha.replicaCount + status.shardBeta.replicaCount;
};
const bytes = (label) => Buffer.from(`purge-test-${RUN_ID}-${label}-${randomUUID()}`);

async function providerStillHolds(doc) {
  try { await getProvider(doc.pinProvider).fetchReplica(doc.cidAlpha); return true; } catch { return false; }
}

test("deleting an object in an unversioned bucket unpins its shards and clears its replica records", async () => {
  const orgId = await makeTestOrg("unversioned-delete");
  const doc = await putS3Object({ orgId, bucket: "b", key: "a.txt", bodyBuffer: bytes("a"), actorEmail: "t@example.com" });
  assert.ok((await replicaCount(doc.fileHash)) > 0, "the upload should have registered replicas");
  assert.equal(await providerStillHolds(doc), true, "bytes are at the provider before the delete");

  await deleteS3Object({ orgId, bucket: "b", key: "a.txt", actorEmail: "t@example.com" });

  assert.equal(await replicaCount(doc.fileHash), 0);
  assert.equal(await providerStillHolds(doc), false, "bytes are gone from the provider after the delete");
  const row = await collections.orgDocuments.findOne({ _id: doc._id });
  assert.ok(row.storagePurgedAt);
  assert.equal(row.purgePending, undefined);
});

test("overwriting a key in an unversioned bucket purges the replaced object but keeps the new one", async () => {
  const orgId = await makeTestOrg("overwrite");
  const first = await putS3Object({ orgId, bucket: "b", key: "k.txt", bodyBuffer: bytes("one"), actorEmail: "t@example.com" });
  const second = await putS3Object({ orgId, bucket: "b", key: "k.txt", bodyBuffer: bytes("two"), actorEmail: "t@example.com" });

  assert.equal(await replicaCount(first.fileHash), 0);
  assert.equal(await providerStillHolds(first), false);
  assert.ok((await replicaCount(second.fileHash)) > 0);
  assert.equal(await providerStillHolds(second), true);
});

test("a plain DELETE in a versioned bucket only adds a delete marker -- the bytes are kept", async () => {
  const orgId = await makeTestOrg("versioned-marker");
  await putBucketVersioning({ orgId, bucket: "b", status: "Enabled" });
  const doc = await putS3Object({ orgId, bucket: "b", key: "v.txt", bodyBuffer: bytes("v"), actorEmail: "t@example.com" });

  const result = await deleteS3Object({ orgId, bucket: "b", key: "v.txt", actorEmail: "t@example.com" });
  assert.equal(result.deleteMarker, true);

  assert.ok((await replicaCount(doc.fileHash)) > 0);
  assert.equal(await providerStillHolds(doc), true);
  const row = await collections.orgDocuments.findOne({ _id: doc._id });
  assert.equal(row.storagePurgedAt, undefined);
});

test("deleting a specific version in a versioned bucket purges that version's bytes", async () => {
  const orgId = await makeTestOrg("versioned-specific");
  await putBucketVersioning({ orgId, bucket: "b", status: "Enabled" });
  const v1 = await putS3Object({ orgId, bucket: "b", key: "s.txt", bodyBuffer: bytes("s1"), actorEmail: "t@example.com" });
  const v2 = await putS3Object({ orgId, bucket: "b", key: "s.txt", bodyBuffer: bytes("s2"), actorEmail: "t@example.com" });

  await deleteS3Object({ orgId, bucket: "b", key: "s.txt", versionId: v1.versionId, actorEmail: "t@example.com" });

  assert.equal(await replicaCount(v1.fileHash), 0);
  assert.equal(await providerStillHolds(v1), false);
  assert.ok((await replicaCount(v2.fileHash)) > 0, "the other version is untouched");
  assert.ok(await getS3ObjectBody({ orgId, bucket: "b", key: "s.txt" }));
  assert.ok((await listObjectVersions({ orgId, bucket: "b", key: "s.txt" })).length >= 1);
});

test("sweepPendingPurges retries a purge that was marked pending", async () => {
  const orgId = await makeTestOrg("sweep");
  const doc = await putS3Object({ orgId, bucket: "b", key: "p.txt", bodyBuffer: bytes("p"), actorEmail: "t@example.com" });
  // Simulate "the provider was down during the delete": row soft-deleted and flagged, bytes still pinned.
  await collections.orgDocuments.updateOne({ _id: doc._id }, { $set: { deletedAt: new Date().toISOString(), purgePending: true } });
  assert.equal(await providerStillHolds(doc), true);

  const swept = await sweepPendingPurges({ limit: 20 });
  assert.ok(swept.purged >= 1);

  assert.equal(await replicaCount(doc.fileHash), 0);
  assert.equal(await providerStillHolds(doc), false);
  const row = await collections.orgDocuments.findOne({ _id: doc._id });
  assert.ok(row.storagePurgedAt);
  assert.equal(row.purgePending, undefined);
});
