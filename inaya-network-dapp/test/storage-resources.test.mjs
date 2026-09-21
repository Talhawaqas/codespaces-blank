// test/storage-resources.test.mjs
// IBM Cloud VPC Storage Gap Expansion SOW, Workstreams A/B/C/D.
// Run with: node --env-file=.env.local --test test/storage-resources.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { ensureS3CompatIndexes, issueS3Credential } from "../src/lib/s3-compat/credentials.js";
import mongoClientPromise from "../src/lib/mongodb.js";
import {
  createStorageResource, listStorageResources, getStorageResource,
  expandStorageResourceCapacity, deleteStorageResource,
  attachVolume, detachVolume, addMountTarget, removeMountTarget,
  normalizeTags, matchesSelector,
} from "../src/lib/storageResources.js";

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
    collections.orgActivity.deleteMany({ orgId: { $in: cleanup.orgIds } }),
    collections.db.collection("s3_credentials").deleteMany({ ownerId: { $in: cleanup.orgIds.map((id) => id.toString()) } }),
    collections.db.collection("s3_owner_keys").deleteMany({ ownerId: { $in: cleanup.orgIds.map((id) => id.toString()) } }),
    collections.projects.deleteMany({ orgId: { $in: cleanup.orgIds } }),
  ]);
  const client = await mongoClientPromise;
  await client.close();
});

async function makeTestOrg(label) {
  const orgId = new ObjectId();
  await collections.orgs.insertOne({ _id: orgId, name: `storage-resources-test-${RUN_ID}-${label}`, createdAt: new Date().toISOString() });
  cleanup.orgIds.push(orgId);
  const managerMembership = { role: "member", storageRole: "manager", email: `mgr-${RUN_ID}-${label}@example.com` };
  const staffMembership = { role: "member", storageRole: "staff", email: `staff-${RUN_ID}-${label}@example.com` };
  const outsiderMembership = { role: "member", email: `outsider-${RUN_ID}-${label}@example.com` };
  await issueS3Credential({ owner: { type: "org", orgId: orgId.toString() }, actorEmail: managerMembership.email });
  return { orgId: orgId.toString(), managerMembership, staffMembership, outsiderMembership };
}

test("normalizeTags enforces the same limits s3-compat objects use, generalized across resource types", () => {
  assert.deepEqual(normalizeTags(null), {});
  assert.deepEqual(normalizeTags({ env: "prod" }), { env: "prod" });
  assert.throws(() => normalizeTags({ "": "x" }), /invalid or too long/);
  const tooMany = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, "v"]));
  assert.throws(() => normalizeTags(tooMany), /at most 10 tags/);
});

test("matchesSelector requires every selector key to match exactly", () => {
  assert.equal(matchesSelector({ env: "prod", team: "core" }, { env: "prod" }), true);
  assert.equal(matchesSelector({ env: "staging" }, { env: "prod" }), false);
  assert.equal(matchesSelector({}, {}), true);
  assert.equal(matchesSelector(undefined, { env: "prod" }), false);
});

test("createStorageResource requires storage-manager access, not just membership", async () => {
  const { orgId, staffMembership, outsiderMembership } = await makeTestOrg("create-perms");
  const deniedOutsider = await createStorageResource({ orgId, type: "volume", name: "v1", membership: outsiderMembership, actorEmail: outsiderMembership.email });
  assert.equal(deniedOutsider.status, 403);
  const deniedStaff = await createStorageResource({ orgId, type: "volume", name: "v1", membership: staffMembership, actorEmail: staffMembership.email });
  assert.equal(deniedStaff.status, 403, "staff can access but not manage storage");
});

test("createStorageResource creates a real backing bucket and honest, non-enforced capability fields", async () => {
  const { orgId, managerMembership } = await makeTestOrg("create-volume");
  const { resource } = await createStorageResource({ orgId, type: "volume", name: `vol-${RUN_ID}`, capacity: 100, performanceProfile: { iops: 3000 }, tags: { env: "prod" }, membership: managerMembership, actorEmail: managerMembership.email });
  assert.equal(resource.type, "volume");
  assert.equal(resource.status, "AVAILABLE");
  assert.equal(resource.attachmentState, "AVAILABLE");
  assert.equal(resource.physicalCapability, "logical_only_no_compute_attach");
  assert.equal(resource.capacity.enforced, false);
  assert.equal(resource.performanceProfile.enforced, false);
  assert.equal(resource.region, "default");

  const bucketDoc = await collections.projects.findOne({ orgId: new ObjectId(orgId), name: resource.backingBucket });
  assert.ok(bucketDoc, "a real backing S3-compat bucket must exist");
});

test("fileShare resources start with an empty mountTargets array and the honest no-NFS-server flag", async () => {
  const { orgId, managerMembership } = await makeTestOrg("create-fileshare");
  const { resource } = await createStorageResource({ orgId, type: "fileShare", name: `share-${RUN_ID}`, membership: managerMembership, actorEmail: managerMembership.email });
  assert.equal(resource.physicalCapability, "logical_only_no_nfs_server");
  assert.deepEqual(resource.mountTargets, []);
});

test("unknown resource type is rejected", async () => {
  const { orgId, managerMembership } = await makeTestOrg("bad-type");
  const result = await createStorageResource({ orgId, type: "compute-instance", name: "x", membership: managerMembership, actorEmail: managerMembership.email });
  assert.equal(result.status, 400);
});

test("listStorageResources filters by type and tag selector; staff can list (access, not manage)", async () => {
  const { orgId, managerMembership, staffMembership } = await makeTestOrg("list");
  await createStorageResource({ orgId, type: "volume", name: "v-prod", tags: { env: "prod" }, membership: managerMembership, actorEmail: managerMembership.email });
  await createStorageResource({ orgId, type: "volume", name: "v-staging", tags: { env: "staging" }, membership: managerMembership, actorEmail: managerMembership.email });
  await createStorageResource({ orgId, type: "fileShare", name: "share-1", membership: managerMembership, actorEmail: managerMembership.email });

  const { resources: allVolumes } = await listStorageResources({ orgId, type: "volume", membership: staffMembership });
  assert.equal(allVolumes.length, 2);

  const { resources: prodOnly } = await listStorageResources({ orgId, tagSelector: { env: "prod" }, membership: staffMembership });
  assert.equal(prodOnly.length, 1);
  assert.equal(prodOnly[0].name, "v-prod");
});

test("expandStorageResourceCapacity allows increase only, never decrease", async () => {
  const { orgId, managerMembership } = await makeTestOrg("expand");
  const { resource } = await createStorageResource({ orgId, type: "volume", name: "v1", capacity: 100, membership: managerMembership, actorEmail: managerMembership.email });

  const grown = await expandStorageResourceCapacity({ orgId, resourceId: resource._id, newCapacityGB: 200, membership: managerMembership, actorEmail: managerMembership.email });
  assert.equal(grown.requestedGB, 200);

  const shrink = await expandStorageResourceCapacity({ orgId, resourceId: resource._id, newCapacityGB: 150, membership: managerMembership, actorEmail: managerMembership.email });
  assert.equal(shrink.status, 400);
  assert.match(shrink.error, /not supported/);
});

test("volume attach/detach is a real reservation -- rejects a conflicting second attach", async () => {
  const { orgId, managerMembership, staffMembership } = await makeTestOrg("attach");
  const { resource } = await createStorageResource({ orgId, type: "volume", name: "v1", membership: managerMembership, actorEmail: managerMembership.email });

  const attached = await attachVolume({ orgId, resourceId: resource._id, attachedTo: "desktop-app:host-1", membership: staffMembership, actorEmail: staffMembership.email });
  assert.equal(attached.attachmentState, "ATTACHED");
  assert.equal(attached.attachedTo, "desktop-app:host-1");

  const conflict = await attachVolume({ orgId, resourceId: resource._id, attachedTo: "directsync:folder-2", membership: staffMembership, actorEmail: staffMembership.email });
  assert.equal(conflict.status, 409);

  const detached = await detachVolume({ orgId, resourceId: resource._id, membership: staffMembership, actorEmail: staffMembership.email });
  assert.equal(detached.attachmentState, "AVAILABLE");

  const reattached = await attachVolume({ orgId, resourceId: resource._id, attachedTo: "directsync:folder-2", membership: staffMembership, actorEmail: staffMembership.email });
  assert.equal(reattached.attachmentState, "ATTACHED", "attaching after a real detach must succeed");
});

test("deleteStorageResource refuses to delete an attached volume", async () => {
  const { orgId, managerMembership, staffMembership } = await makeTestOrg("delete-attached");
  const { resource } = await createStorageResource({ orgId, type: "volume", name: "v1", membership: managerMembership, actorEmail: managerMembership.email });
  await attachVolume({ orgId, resourceId: resource._id, attachedTo: "x", membership: staffMembership, actorEmail: staffMembership.email });

  const blocked = await deleteStorageResource({ orgId, resourceId: resource._id, membership: managerMembership, actorEmail: managerMembership.email });
  assert.equal(blocked.status, 409);

  await detachVolume({ orgId, resourceId: resource._id, membership: staffMembership, actorEmail: staffMembership.email });
  const deleted = await deleteStorageResource({ orgId, resourceId: resource._id, membership: managerMembership, actorEmail: managerMembership.email });
  assert.equal(deleted.deleted, true);

  const { error, status } = await getStorageResource({ orgId, resourceId: resource._id, membership: managerMembership });
  assert.equal(status, 404, "a deleted resource must not be findable");
  assert.ok(error);
});

test("mount targets are declared bookkeeping only, never physically mountable", async () => {
  const { orgId, managerMembership } = await makeTestOrg("mount-targets");
  const { resource } = await createStorageResource({ orgId, type: "fileShare", name: "share-1", membership: managerMembership, actorEmail: managerMembership.email });

  const { mountTarget } = await addMountTarget({ orgId, resourceId: resource._id, label: "prod-client-1", authorizedClients: ["10.0.0.0/24"], membership: managerMembership, actorEmail: managerMembership.email });
  assert.equal(mountTarget.physicallyMountable, false);

  const { resource: updated } = await getStorageResource({ orgId, resourceId: resource._id, membership: managerMembership });
  assert.equal(updated.mountTargets.length, 1);

  await removeMountTarget({ orgId, resourceId: resource._id, mountTargetId: mountTarget.id.toString(), membership: managerMembership, actorEmail: managerMembership.email });
  const { resource: afterRemove } = await getStorageResource({ orgId, resourceId: resource._id, membership: managerMembership });
  assert.equal(afterRemove.mountTargets.length, 0);
});

test("organization isolation: one org cannot see or act on another org's storage resource", async () => {
  const orgA = await makeTestOrg("iso-a");
  const orgB = await makeTestOrg("iso-b");
  const { resource } = await createStorageResource({ orgId: orgA.orgId, type: "volume", name: "v1", membership: orgA.managerMembership, actorEmail: orgA.managerMembership.email });

  const crossOrgRead = await getStorageResource({ orgId: orgB.orgId, resourceId: resource._id, membership: orgB.managerMembership });
  assert.equal(crossOrgRead.status, 404);

  const crossOrgAttach = await attachVolume({ orgId: orgB.orgId, resourceId: resource._id, attachedTo: "x", membership: orgB.managerMembership, actorEmail: orgB.managerMembership.email });
  assert.equal(crossOrgAttach.status, 404);
});
