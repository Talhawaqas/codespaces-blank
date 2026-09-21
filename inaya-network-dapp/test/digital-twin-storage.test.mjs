// test/digital-twin-storage.test.mjs
// IBM Cloud VPC Storage Gap Expansion SOW, Workstream U -- the two new
// storage-related Digital Twin scenarios (STORAGE_RESOURCE_UNAVAILABLE,
// BACKUP_POLICY_DISABLED) and the STORAGE_RESOURCE dependent-resolver's
// own permission gate (canAccessStorage, not canAccessDepartment -- see
// digitalTwin.js's own special-case comment for why).
//
// Run with: node --env-file=.env.local --test test/digital-twin-storage.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { ensureS3CompatIndexes, issueS3Credential } from "../src/lib/s3-compat/credentials.js";
import mongoClientPromise from "../src/lib/mongodb.js";
import { resolveDependents } from "../src/lib/digitalTwin.js";
import { simulateDigitalTwinScenario } from "../src/lib/digitalTwinSimulate.js";
import { createStorageResource, attachVolume } from "../src/lib/storageResources.js";
import { createSnapshot } from "../src/lib/storageSnapshots.js";
import { createBackupPolicy, createBackupPlan } from "../src/lib/storageBackupPolicies.js";

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
    collections.storageBackupPolicies.deleteMany({ orgId: { $in: cleanup.orgIds } }),
    collections.storageBackupPlans.deleteMany({ orgId: { $in: cleanup.orgIds } }),
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
  await collections.orgs.insertOne({ _id: orgId, name: `digital-twin-storage-test-${RUN_ID}-${label}`, createdAt: new Date().toISOString() });
  cleanup.orgIds.push(orgId);
  const ownerMembership = { role: "owner", email: `owner-${RUN_ID}-${label}@example.com` };
  const staffMembership = { role: "member", email: `staff-${RUN_ID}-${label}@example.com` }; // no storageRole -- must be denied storage access
  await issueS3Credential({ owner: { type: "org", orgId: orgId.toString() }, actorEmail: ownerMembership.email });
  return { orgId: orgId.toString(), ownerMembership, staffMembership };
}

test("resolveDependents(STORAGE_RESOURCE) discloses a snapshot's existence but not its content to a member without storage access (SECURITY)", async () => {
  const { orgId, ownerMembership, staffMembership } = await makeTestOrg("resolve-perm");
  const { resource } = await createStorageResource({ orgId, type: "volume", name: "v1", membership: ownerMembership, actorEmail: ownerMembership.email });
  const { snapshot } = await createSnapshot({ orgId, resourceId: resource._id, membership: ownerMembership, actorEmail: ownerMembership.email });

  const forOwner = await resolveDependents({ orgId, entityType: "STORAGE_RESOURCE", entityId: resource._id, membership: ownerMembership });
  const ownerSnap = forOwner.find((d) => d.targetType === "STORAGE_SNAPSHOT");
  assert.equal(ownerSnap.targetId, snapshot._id.toString());
  assert.equal(ownerSnap.state, "INCLUDED");
  assert.ok(ownerSnap.summary);

  const forStaff = await resolveDependents({ orgId, entityType: "STORAGE_RESOURCE", entityId: resource._id, membership: staffMembership });
  const staffSnap = forStaff.find((d) => d.targetType === "STORAGE_SNAPSHOT");
  assert.equal(staffSnap.state, "RESTRICTED");
  assert.equal(staffSnap.summary, undefined, "a member without storage access must never see a snapshot's summary");
});

test("STORAGE_RESOURCE_UNAVAILABLE reports real attachment state and available snapshots, denies a non-storage member", async () => {
  const { orgId, ownerMembership, staffMembership } = await makeTestOrg("sim-resource");
  const { resource } = await createStorageResource({ orgId, type: "volume", name: "v1", membership: ownerMembership, actorEmail: ownerMembership.email });
  await attachVolume({ orgId, resourceId: resource._id, attachedTo: "desktop-app:host-1", membership: ownerMembership, actorEmail: ownerMembership.email });
  await createSnapshot({ orgId, resourceId: resource._id, membership: ownerMembership, actorEmail: ownerMembership.email });

  const denied = await simulateDigitalTwinScenario({ orgId, scenarioType: "STORAGE_RESOURCE_UNAVAILABLE", entityId: resource._id, membership: staffMembership, actorEmail: staffMembership.email });
  assert.equal(denied.error, "You don't have permission to simulate this.");

  const { simulation } = await simulateDigitalTwinScenario({ orgId, scenarioType: "STORAGE_RESOURCE_UNAVAILABLE", entityId: resource._id, membership: ownerMembership, actorEmail: ownerMembership.email });
  assert.equal(simulation.directImpact.status, "IMPACT_DETECTED");
  assert.equal(simulation.directImpact.currentAttachmentState, "ATTACHED");
  assert.equal(simulation.directImpact.attachedTo, "desktop-app:host-1");
  assert.equal(simulation.directImpact.availableSnapshots.length, 1);
  assert.equal(simulation.noChangesWereMade, true);
});

test("BACKUP_POLICY_DISABLED reports exactly the resources matching the policy's own tag selector, never resources outside it", async () => {
  const { orgId, ownerMembership } = await makeTestOrg("sim-policy");
  await createStorageResource({ orgId, type: "volume", name: "v-prod", tags: { env: "prod" }, membership: ownerMembership, actorEmail: ownerMembership.email });
  await createStorageResource({ orgId, type: "volume", name: "v-staging", tags: { env: "staging" }, membership: ownerMembership, actorEmail: ownerMembership.email });
  const { policy } = await createBackupPolicy({ orgId, name: "Prod Only", tagSelector: { env: "prod" }, membership: ownerMembership, actorEmail: ownerMembership.email });
  await createBackupPlan({ orgId, policyId: policy._id, frequency: "daily", retentionCount: 3, membership: ownerMembership, actorEmail: ownerMembership.email });

  const { simulation } = await simulateDigitalTwinScenario({ orgId, scenarioType: "BACKUP_POLICY_DISABLED", entityId: policy._id, membership: ownerMembership, actorEmail: ownerMembership.email });
  assert.equal(simulation.directImpact.status, "IMPACT_DETECTED");
  assert.equal(simulation.directImpact.resourcesNoLongerProtected.length, 1);
  assert.equal(simulation.directImpact.resourcesNoLongerProtected[0].name, "v-prod");
  assert.equal(simulation.directImpact.plansAffected.length, 1);
  assert.equal(simulation.noChangesWereMade, true);
});

test("SECURITY: neither new storage scenario mutates any real storage record it reads", async () => {
  const { orgId, ownerMembership } = await makeTestOrg("sim-nomutate");
  const { resource } = await createStorageResource({ orgId, type: "volume", name: "v1", tags: { env: "prod" }, membership: ownerMembership, actorEmail: ownerMembership.email });
  const { snapshot } = await createSnapshot({ orgId, resourceId: resource._id, membership: ownerMembership, actorEmail: ownerMembership.email });
  const { policy } = await createBackupPolicy({ orgId, name: "P1", tagSelector: { env: "prod" }, membership: ownerMembership, actorEmail: ownerMembership.email });

  const snap = async () => ({
    resource: await collections.storageResources.findOne({ _id: resource._id }),
    snapshot: await collections.storageSnapshots.findOne({ _id: snapshot._id }),
    policy: await collections.storageBackupPolicies.findOne({ _id: policy._id }),
  });

  const before = await snap();
  await simulateDigitalTwinScenario({ orgId, scenarioType: "STORAGE_RESOURCE_UNAVAILABLE", entityId: resource._id, membership: ownerMembership, actorEmail: ownerMembership.email });
  await simulateDigitalTwinScenario({ orgId, scenarioType: "BACKUP_POLICY_DISABLED", entityId: policy._id, membership: ownerMembership, actorEmail: ownerMembership.email });
  const after = await snap();

  assert.deepEqual(after, before, "no storage scenario may mutate any real record it reads");
});
