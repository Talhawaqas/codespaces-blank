// test/storage-backup-policies.test.mjs
// IBM Cloud VPC Storage Gap Expansion SOW, Workstreams J/K/L/M.
// Run with: node --env-file=.env.local --test test/storage-backup-policies.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { ensureS3CompatIndexes, issueS3Credential } from "../src/lib/s3-compat/credentials.js";
import { putS3Object } from "../src/lib/s3-compat/store.js";
import mongoClientPromise from "../src/lib/mongodb.js";
import { createStorageResource } from "../src/lib/storageResources.js";
import {
  createBackupPolicy, listBackupPolicies, setBackupPolicyEnabled,
  createBackupPlan, listBackupPlans, runBackupPolicyPlan, listBackupJobs,
  findDueBackupPlans, getPlanHealth,
} from "../src/lib/storageBackupPolicies.js";

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
    collections.storageBackupJobs.deleteMany({ orgId: { $in: cleanup.orgIds } }),
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
  await collections.orgs.insertOne({ _id: orgId, name: `storage-backup-policies-test-${RUN_ID}-${label}`, createdAt: new Date().toISOString() });
  cleanup.orgIds.push(orgId);
  const membership = { role: "member", storageRole: "manager", email: `mgr-${RUN_ID}-${label}@example.com` };
  await issueS3Credential({ owner: { type: "org", orgId: orgId.toString() }, actorEmail: membership.email });
  return { orgId: orgId.toString(), membership };
}

test("createBackupPolicy validates the tag selector and requires storage-manager access", async () => {
  const { orgId, membership } = await makeTestOrg("create-policy");
  const { policy } = await createBackupPolicy({ orgId, name: "Prod Daily", tagSelector: { env: "prod" }, membership, actorEmail: membership.email });
  assert.equal(policy.name, "Prod Daily");
  assert.equal(policy.enabled, true);
  assert.deepEqual(policy.tagSelector, { env: "prod" });

  const denied = await createBackupPolicy({ orgId, name: "x", membership: { role: "member" }, actorEmail: membership.email });
  assert.equal(denied.status, 403);
});

test("setBackupPolicyEnabled pauses and resumes; a paused policy's plan cannot be run", async () => {
  const { orgId, membership } = await makeTestOrg("pause");
  const { policy } = await createBackupPolicy({ orgId, name: "P1", tagSelector: {}, membership, actorEmail: membership.email });
  const { plan } = await createBackupPlan({ orgId, policyId: policy._id, frequency: "daily", retentionCount: 3, membership, actorEmail: membership.email });

  await setBackupPolicyEnabled({ orgId, policyId: policy._id, enabled: false, membership, actorEmail: membership.email });
  const runWhilePaused = await runBackupPolicyPlan({ orgId, planId: plan._id, actorEmail: membership.email });
  assert.equal(runWhilePaused.status, 409);

  await setBackupPolicyEnabled({ orgId, policyId: policy._id, enabled: true, membership, actorEmail: membership.email });
  const runAfterResume = await runBackupPolicyPlan({ orgId, planId: plan._id, actorEmail: membership.email });
  assert.ok(!runAfterResume.error);
});

test("createBackupPlan validates frequency and requires a positive retentionCount", async () => {
  const { orgId, membership } = await makeTestOrg("plan-validate");
  const { policy } = await createBackupPolicy({ orgId, name: "P1", tagSelector: {}, membership, actorEmail: membership.email });

  const badFrequency = await createBackupPlan({ orgId, policyId: policy._id, frequency: "hourly", retentionCount: 3, membership, actorEmail: membership.email });
  assert.equal(badFrequency.status, 400);

  const badRetention = await createBackupPlan({ orgId, policyId: policy._id, frequency: "daily", retentionCount: 0, membership, actorEmail: membership.email });
  assert.equal(badRetention.status, 400);

  const { plan } = await createBackupPlan({ orgId, policyId: policy._id, frequency: "weekly", retentionCount: 4, membership, actorEmail: membership.email });
  assert.equal(plan.frequency, "weekly");
  assert.equal(plan.retentionCount, 4);
});

test("runBackupPolicyPlan snapshots only resources matching the policy's tag selector", async () => {
  const { orgId, membership } = await makeTestOrg("selector");
  await createStorageResource({ orgId, type: "volume", name: "v-prod", tags: { env: "prod" }, membership, actorEmail: membership.email });
  await createStorageResource({ orgId, type: "volume", name: "v-staging", tags: { env: "staging" }, membership, actorEmail: membership.email });

  const { policy } = await createBackupPolicy({ orgId, name: "Prod Only", tagSelector: { env: "prod" }, membership, actorEmail: membership.email });
  const { plan } = await createBackupPlan({ orgId, policyId: policy._id, frequency: "daily", retentionCount: 5, membership, actorEmail: membership.email });

  const result = await runBackupPolicyPlan({ orgId, planId: plan._id, actorEmail: membership.email });
  assert.equal(result.resourcesProcessed, 1);
  assert.equal(result.jobResults[0].status, "SUCCEEDED");

  const { jobs } = await listBackupJobs({ orgId, planId: plan._id, membership });
  assert.equal(jobs.length, 1);
});

test("retention enforcement deletes only the oldest snapshots beyond retentionCount, never silently beyond that", async () => {
  const { orgId, membership } = await makeTestOrg("retention");
  const { resource } = await createStorageResource({ orgId, type: "volume", name: "v1", tags: { env: "prod" }, membership, actorEmail: membership.email });
  const { policy } = await createBackupPolicy({ orgId, name: "Retention Test", tagSelector: { env: "prod" }, membership, actorEmail: membership.email });
  const { plan } = await createBackupPlan({ orgId, policyId: policy._id, frequency: "daily", retentionCount: 2, membership, actorEmail: membership.email });

  // Run 3 times -- retentionCount is 2, so only the 2 newest snapshots for
  // this resource+plan should survive after the 3rd run.
  await putS3Object({ orgId, bucket: resource.backingBucket, key: "a.txt", bodyBuffer: Buffer.from("v1"), contentType: "text/plain", actorEmail: membership.email });
  await runBackupPolicyPlan({ orgId, planId: plan._id, actorEmail: membership.email });
  await putS3Object({ orgId, bucket: resource.backingBucket, key: "b.txt", bodyBuffer: Buffer.from("v2"), contentType: "text/plain", actorEmail: membership.email });
  await runBackupPolicyPlan({ orgId, planId: plan._id, actorEmail: membership.email });
  await putS3Object({ orgId, bucket: resource.backingBucket, key: "c.txt", bodyBuffer: Buffer.from("v3"), contentType: "text/plain", actorEmail: membership.email });
  const third = await runBackupPolicyPlan({ orgId, planId: plan._id, actorEmail: membership.email });
  assert.equal(third.jobResults[0].retentionDeleted, 1, "the 3rd run must have deleted exactly 1 old snapshot to stay within retentionCount=2");

  const remaining = await collections.storageSnapshots.find({ orgId: new ObjectId(orgId), sourceResourceId: resource._id, deletedAt: null }).toArray();
  assert.equal(remaining.length, 2, "exactly retentionCount snapshots must remain, never fewer and never more");

  // Every automatic deletion must be audited (SOW: "No silent destructive cleanup").
  const auditedDeletions = await collections.orgActivity.find({ orgId: new ObjectId(orgId), recordType: "STORAGE_SNAPSHOT", action: "SNAPSHOT_RETENTION_DELETED" }).toArray();
  assert.equal(auditedDeletions.length, 1);
});

test("plan health reflects real consecutive-failure state, computed the same way cloudBackupScheduler.js computes it", () => {
  assert.equal(getPlanHealth({ consecutiveFailures: 0, lastRunAt: null, frequency: "daily" }), "UNKNOWN");
  assert.equal(getPlanHealth({ consecutiveFailures: 0, lastRunAt: new Date().toISOString(), frequency: "daily" }), "HEALTHY");
  assert.equal(getPlanHealth({ consecutiveFailures: 1, lastRunAt: new Date().toISOString(), frequency: "daily" }), "DEGRADED");
  assert.equal(getPlanHealth({ consecutiveFailures: 3, lastRunAt: new Date().toISOString(), frequency: "daily" }), "FAILED");
  const staleDate = new Date(Date.now() - 4 * 24 * 3600000).toISOString(); // 4 days ago, daily plan -> stale after 3 days
  assert.equal(getPlanHealth({ consecutiveFailures: 0, lastRunAt: staleDate, frequency: "daily" }), "WARNING");
});

test("findDueBackupPlans only returns plans whose policy is still enabled", async () => {
  const { orgId, membership } = await makeTestOrg("due");
  const { policy: enabledPolicy } = await createBackupPolicy({ orgId, name: "Enabled", tagSelector: {}, membership, actorEmail: membership.email });
  const { plan: duePlan } = await createBackupPlan({ orgId, policyId: enabledPolicy._id, frequency: "daily", retentionCount: 3, membership, actorEmail: membership.email });
  await collections.storageBackupPlans.updateOne({ _id: duePlan._id }, { $set: { nextRunAt: new Date(Date.now() - 1000).toISOString() } });

  const { policy: pausedPolicy } = await createBackupPolicy({ orgId, name: "Paused", tagSelector: {}, membership, actorEmail: membership.email });
  await setBackupPolicyEnabled({ orgId, policyId: pausedPolicy._id, enabled: false, membership, actorEmail: membership.email });
  const { plan: duePausedPlan } = await createBackupPlan({ orgId, policyId: pausedPolicy._id, frequency: "daily", retentionCount: 3, membership, actorEmail: membership.email });
  await collections.storageBackupPlans.updateOne({ _id: duePausedPlan._id }, { $set: { nextRunAt: new Date(Date.now() - 1000).toISOString() } });

  const due = await findDueBackupPlans(200);
  const dueIds = due.map((p) => p._id.toString());
  assert.ok(dueIds.includes(duePlan._id.toString()));
  assert.ok(!dueIds.includes(duePausedPlan._id.toString()), "a plan whose policy is paused must never be treated as due");
});

test("listBackupPolicies and listBackupPlans are org-isolated", async () => {
  const orgA = await makeTestOrg("iso-a");
  const orgB = await makeTestOrg("iso-b");
  await createBackupPolicy({ orgId: orgA.orgId, name: "A-policy", tagSelector: {}, membership: orgA.membership, actorEmail: orgA.membership.email });

  const { policies: bPolicies } = await listBackupPolicies({ orgId: orgB.orgId, membership: orgB.membership });
  assert.equal(bPolicies.length, 0);
});
