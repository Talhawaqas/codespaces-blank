// test/storage-snapshots.test.mjs
// IBM Cloud VPC Storage Gap Expansion SOW, Workstreams E/F/G/I.
// Run with: node --env-file=.env.local --test test/storage-snapshots.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { ensureS3CompatIndexes, issueS3Credential } from "../src/lib/s3-compat/credentials.js";
import { putS3Object, listS3Objects } from "../src/lib/s3-compat/store.js";
import mongoClientPromise from "../src/lib/mongodb.js";
import { createStorageResource } from "../src/lib/storageResources.js";
import {
  createSnapshot, listSnapshots, getSnapshot, restoreSnapshot, deleteSnapshot,
  createConsistencyGroup, copySnapshotToResource,
  shareSnapshot, revokeSnapshotGrant, resolveSnapshotGrant,
} from "../src/lib/storageSnapshots.js";

const RUN_ID = randomUUID().slice(0, 8);
const cleanup = { orgIds: [] };
let collections;

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
  await ensureS3CompatIndexes(collections.db);
});

after(async () => {
  await Promise.all([
    collections.orgs.deleteMany({ _id: { $in: cleanup.orgIds } }),
    collections.storageResources.deleteMany({ orgId: { $in: cleanup.orgIds } }),
    collections.storageSnapshots.deleteMany({ orgId: { $in: cleanup.orgIds } }),
    collections.consistencyGroups.deleteMany({ orgId: { $in: cleanup.orgIds } }),
    collections.snapshotGrants.deleteMany({ orgId: { $in: cleanup.orgIds } }),
    collections.orgActivity.deleteMany({ orgId: { $in: cleanup.orgIds } }),
    collections.orgDocuments.deleteMany({ orgId: { $in: cleanup.orgIds } }),
    collections.db.collection("s3_credentials").deleteMany({ ownerId: { $in: cleanup.orgIds.map((id) => id.toString()) } }),
    collections.db.collection("s3_owner_keys").deleteMany({ ownerId: { $in: cleanup.orgIds.map((id) => id.toString()) } }),
    collections.projects.deleteMany({ orgId: { $in: cleanup.orgIds } }),
  ]);
  const client = await mongoClientPromise;
  await client.close();
});

async function makeTestOrg(label) {
  const orgId = new ObjectId();
  await collections.orgs.insertOne({ _id: orgId, name: `storage-snapshots-test-${RUN_ID}-${label}`, createdAt: new Date().toISOString() });
  cleanup.orgIds.push(orgId);
  const membership = { role: "member", storageRole: "manager", email: `mgr-${RUN_ID}-${label}@example.com` };
  await issueS3Credential({ owner: { type: "org", orgId: orgId.toString() }, actorEmail: membership.email });
  return { orgId: orgId.toString(), membership };
}

test("createSnapshot captures a real, incremental (reference-only) manifest and an independently recomputable integrity hash", async () => {
  const { orgId, membership } = await makeTestOrg("create");
  const { resource } = await createStorageResource({ orgId, type: "volume", name: "v1", membership, actorEmail: membership.email });
  await putS3Object({ orgId, bucket: resource.backingBucket, key: "a.txt", bodyBuffer: Buffer.from("hello a"), contentType: "text/plain", actorEmail: membership.email });
  await putS3Object({ orgId, bucket: resource.backingBucket, key: "b.txt", bodyBuffer: Buffer.from("hello b"), contentType: "text/plain", actorEmail: membership.email });

  const { snapshot } = await createSnapshot({ orgId, resourceId: resource._id, membership, actorEmail: membership.email });
  assert.equal(snapshot.status, "AVAILABLE");
  assert.equal(snapshot.snapshotType, "incremental");
  assert.equal(snapshot.manifest.length, 2);
  assert.ok(snapshot.integrityHash);

  const { snapshot: fetched } = await getSnapshot({ orgId, snapshotId: snapshot._id, membership });
  assert.equal(fetched.integrityHash, snapshot.integrityHash);
});

test("createSnapshot auto-enables bucket versioning so the manifest's recorded versions stay retrievable after later writes", async () => {
  const { orgId, membership } = await makeTestOrg("versioning");
  const { resource } = await createStorageResource({ orgId, type: "volume", name: "v1", membership, actorEmail: membership.email });
  await putS3Object({ orgId, bucket: resource.backingBucket, key: "a.txt", bodyBuffer: Buffer.from("v1"), contentType: "text/plain", actorEmail: membership.email });

  const versioningBefore = await collections.projects.findOne({ orgId: new ObjectId(orgId), name: resource.backingBucket });
  assert.notEqual(versioningBefore.versioningStatus, "Enabled", "bucket should not be versioned before any snapshot");

  await createSnapshot({ orgId, resourceId: resource._id, membership, actorEmail: membership.email });
  const versioningAfter = await collections.projects.findOne({ orgId: new ObjectId(orgId), name: resource.backingBucket });
  assert.equal(versioningAfter.versioningStatus, "Enabled");
});

test("restoreSnapshot does a real copy-forward restore of overwritten content", async () => {
  const { orgId, membership } = await makeTestOrg("restore");
  const { resource } = await createStorageResource({ orgId, type: "volume", name: "v1", membership, actorEmail: membership.email });
  await putS3Object({ orgId, bucket: resource.backingBucket, key: "a.txt", bodyBuffer: Buffer.from("original content"), contentType: "text/plain", actorEmail: membership.email });

  const { snapshot } = await createSnapshot({ orgId, resourceId: resource._id, membership, actorEmail: membership.email });

  // Overwrite after the snapshot -- current content is now different.
  await putS3Object({ orgId, bucket: resource.backingBucket, key: "a.txt", bodyBuffer: Buffer.from("MODIFIED content"), contentType: "text/plain", actorEmail: membership.email });

  const result = await restoreSnapshot({ orgId, snapshotId: snapshot._id, membership, actorEmail: membership.email });
  assert.equal(result.status, "RESTORED");
  assert.equal(result.restoredCount, 1);
  assert.equal(result.failedCount, 0);

  const { getS3ObjectBody } = await import("../src/lib/s3-compat/store.js");
  const restored = await getS3ObjectBody({ orgId, bucket: resource.backingBucket, key: "a.txt" });
  assert.equal(restored.buffer.toString(), "original content", "restore must bring back the snapshot's own content, not leave the modified version");
});

test("restoreSnapshot on a resource with no manifest entries is a real, honest no-op success", async () => {
  const { orgId, membership } = await makeTestOrg("restore-empty");
  const { resource } = await createStorageResource({ orgId, type: "volume", name: "v1", membership, actorEmail: membership.email });
  const { snapshot } = await createSnapshot({ orgId, resourceId: resource._id, membership, actorEmail: membership.email });
  assert.equal(snapshot.manifest.length, 0);
  const result = await restoreSnapshot({ orgId, snapshotId: snapshot._id, membership, actorEmail: membership.email });
  assert.equal(result.status, "RESTORED");
  assert.equal(result.restoredCount, 0);
});

test("deleteSnapshot soft-deletes; a deleted snapshot cannot be restored or refetched", async () => {
  const { orgId, membership } = await makeTestOrg("delete");
  const { resource } = await createStorageResource({ orgId, type: "volume", name: "v1", membership, actorEmail: membership.email });
  const { snapshot } = await createSnapshot({ orgId, resourceId: resource._id, membership, actorEmail: membership.email });

  await deleteSnapshot({ orgId, snapshotId: snapshot._id, membership, actorEmail: membership.email });
  const { status } = await getSnapshot({ orgId, snapshotId: snapshot._id, membership });
  assert.equal(status, 404);
  const restoreAttempt = await restoreSnapshot({ orgId, snapshotId: snapshot._id, membership, actorEmail: membership.email });
  assert.equal(restoreAttempt.status, 404);
});

test("createConsistencyGroup captures multiple resources sequentially and honestly discloses a non-atomic consistency boundary", async () => {
  const { orgId, membership } = await makeTestOrg("consistency-group");
  const { resource: r1 } = await createStorageResource({ orgId, type: "volume", name: "v1", membership, actorEmail: membership.email });
  const { resource: r2 } = await createStorageResource({ orgId, type: "volume", name: "v2", membership, actorEmail: membership.email });
  await putS3Object({ orgId, bucket: r1.backingBucket, key: "a.txt", bodyBuffer: Buffer.from("x"), contentType: "text/plain", actorEmail: membership.email });

  const { consistencyGroup } = await createConsistencyGroup({ orgId, resourceIds: [r1._id, r2._id], membership, actorEmail: membership.email });
  assert.equal(consistencyGroup.status, "AVAILABLE");
  assert.equal(consistencyGroup.consistencyBoundary, "SEQUENTIAL_NOT_ATOMIC");
  assert.equal(consistencyGroup.members.length, 2);
  assert.ok(consistencyGroup.captureStartedAt);
  assert.ok(consistencyGroup.captureCompletedAt);
  assert.ok(consistencyGroup.integrityHash);
});

test("createConsistencyGroup rejects fewer than 2 resources", async () => {
  const { orgId, membership } = await makeTestOrg("cg-min");
  const { resource } = await createStorageResource({ orgId, type: "volume", name: "v1", membership, actorEmail: membership.email });
  const result = await createConsistencyGroup({ orgId, resourceIds: [resource._id], membership, actorEmail: membership.email });
  assert.equal(result.status, 400);
});

test("copySnapshotToResource moves real data into a different resource (a different logical region)", async () => {
  const { orgId, membership } = await makeTestOrg("copy");
  const { resource: source } = await createStorageResource({ orgId, type: "volume", name: "v-source", region: "us", membership, actorEmail: membership.email });
  const { resource: dest } = await createStorageResource({ orgId, type: "volume", name: "v-dest", region: "eu", membership, actorEmail: membership.email });
  await putS3Object({ orgId, bucket: source.backingBucket, key: "a.txt", bodyBuffer: Buffer.from("copy me"), contentType: "text/plain", actorEmail: membership.email });

  const { snapshot } = await createSnapshot({ orgId, resourceId: source._id, membership, actorEmail: membership.email });
  const result = await copySnapshotToResource({ orgId, snapshotId: snapshot._id, destinationResourceId: dest._id, membership, actorEmail: membership.email });
  assert.equal(result.copiedCount, 1);
  assert.equal(result.destinationRegion, "eu");

  const listing = await listS3Objects({ orgId, bucket: dest.backingBucket });
  assert.equal(listing.contents.length, 1);
  assert.equal(listing.contents[0].filename, "a.txt");
});

test("cross-org snapshot sharing: grant, resolve, revoke -- fails closed on wrong org, revocation, and expiry", async () => {
  const orgA = await makeTestOrg("share-a");
  const orgB = await makeTestOrg("share-b");
  const orgC = await makeTestOrg("share-c");
  const { resource } = await createStorageResource({ orgId: orgA.orgId, type: "volume", name: "v1", membership: orgA.membership, actorEmail: orgA.membership.email });
  const { snapshot } = await createSnapshot({ orgId: orgA.orgId, resourceId: resource._id, membership: orgA.membership, actorEmail: orgA.membership.email });

  const ownerMembership = { role: "owner", email: orgA.membership.email };
  const { grantId } = await shareSnapshot({ orgId: orgA.orgId, snapshotId: snapshot._id, recipientOrgId: orgB.orgId, operationScope: "restore", membership: ownerMembership, actorEmail: ownerMembership.email });

  const resolvedForB = await resolveSnapshotGrant({ callerOrgId: orgB.orgId, grantId });
  assert.ok(resolvedForB, "the actual recipient org must resolve the grant");

  const resolvedForC = await resolveSnapshotGrant({ callerOrgId: orgC.orgId, grantId });
  assert.equal(resolvedForC, null, "an unrelated org must never resolve someone else's grant");

  await revokeSnapshotGrant({ orgId: orgA.orgId, grantId, membership: ownerMembership, actorEmail: ownerMembership.email });
  const resolvedAfterRevoke = await resolveSnapshotGrant({ callerOrgId: orgB.orgId, grantId });
  assert.equal(resolvedAfterRevoke, null, "a revoked grant must fail closed even for the real recipient");
});

test("shareSnapshot rejects sharing to the same org and requires owner/admin", async () => {
  const { orgId, membership } = await makeTestOrg("share-self");
  const { resource } = await createStorageResource({ orgId, type: "volume", name: "v1", membership, actorEmail: membership.email });
  const { snapshot } = await createSnapshot({ orgId, resourceId: resource._id, membership, actorEmail: membership.email });

  const selfShare = await shareSnapshot({ orgId, snapshotId: snapshot._id, recipientOrgId: orgId, operationScope: "restore", membership: { role: "owner" }, actorEmail: membership.email });
  assert.equal(selfShare.status, 400);

  const notOwner = await shareSnapshot({ orgId, snapshotId: snapshot._id, recipientOrgId: "000000000000000000000001", operationScope: "restore", membership: { role: "member" }, actorEmail: membership.email });
  assert.equal(notOwner.status, 403);
});

test("expired snapshot grant resolves to null even before explicit revocation", async () => {
  const orgA = await makeTestOrg("expiry-a");
  const orgB = await makeTestOrg("expiry-b");
  const { resource } = await createStorageResource({ orgId: orgA.orgId, type: "volume", name: "v1", membership: orgA.membership, actorEmail: orgA.membership.email });
  const { snapshot } = await createSnapshot({ orgId: orgA.orgId, resourceId: resource._id, membership: orgA.membership, actorEmail: orgA.membership.email });

  const ownerMembership = { role: "owner", email: orgA.membership.email };
  const alreadyExpired = new Date(Date.now() - 1000).toISOString();
  const { grantId } = await shareSnapshot({ orgId: orgA.orgId, snapshotId: snapshot._id, recipientOrgId: orgB.orgId, operationScope: "restore", expiresAt: alreadyExpired, membership: ownerMembership, actorEmail: ownerMembership.email });

  const resolved = await resolveSnapshotGrant({ callerOrgId: orgB.orgId, grantId });
  assert.equal(resolved, null);
});
