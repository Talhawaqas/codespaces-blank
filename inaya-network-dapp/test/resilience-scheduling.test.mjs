// test/resilience-scheduling.test.mjs
//
// Autonomous Resilience Layer SOW, Phase 5 coverage: the scheduled sweep
// picks up a policy whose test window has elapsed (or never ran), runs a
// real test against it (one real network round-trip -- bounded to a
// single policy/canary in this file), and updates lastTestAt. Paused
// policies and policies not yet due are left alone.
//
// Run with: node --env-file=.env.local --test --test-timeout=60000 test/resilience-scheduling.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { createPolicy, updatePolicy } from "../src/lib/resilience-policy.js";
import { runScheduledResilienceTests } from "../src/lib/resilience-orchestrator.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const email = (label) => `test-resilienceschedule-${RUN_ID}-${label}@example.com`;
const OWNER = { role: "owner" };

let collections;
const cleanup = { orgIds: [] };

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
});

after(async () => {
  const {
    orgs, orgMembers, departments, projects, orgDocuments,
    resiliencePolicies, resilienceCanaryAssets, resilienceTestRuns,
    orgActivity, auditChainEntries, auditChainHeads,
  } = collections;
  await orgMembers.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await departments.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await projects.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await orgDocuments.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await resiliencePolicies.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await resilienceCanaryAssets.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await resilienceTestRuns.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await orgActivity.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await auditChainEntries.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await auditChainHeads.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await orgs.deleteMany({ _id: { $in: cleanup.orgIds } });
  const client = await mongoClientPromise;
  await client.close();
});

test("runScheduledResilienceTests: sweeps a never-tested ACTIVE policy, skips a paused one", async () => {
  const { orgs, orgMembers } = collections;
  const orgResult = await orgs.insertOne({ name: "Resilience Schedule Test Co", createdAt: new Date().toISOString() });
  cleanup.orgIds.push(orgResult.insertedId);
  const orgId = orgResult.insertedId;
  const ownerEmail = email("owner");
  await orgMembers.insertOne({ orgId, email: ownerEmail, role: "owner", departmentIds: [], status: "active", invitedAt: new Date().toISOString(), joinedAt: new Date().toISOString() });

  const { policy: duePolicy } = await createPolicy({
    orgId, name: "Due Policy", requiredRTOMinutes: 60, requiredRPOMinutes: 1440,
    criticalAssetCategories: [{ label: "General", priority: "STANDARD" }],
    testFrequency: "daily", membership: OWNER, actorEmail: ownerEmail,
  });

  const { policy: pausedPolicy } = await createPolicy({
    orgId, name: "Paused Policy", requiredRTOMinutes: 60, requiredRPOMinutes: 1440,
    criticalAssetCategories: [{ label: "General", priority: "STANDARD" }],
    testFrequency: "daily", membership: OWNER, actorEmail: ownerEmail,
  });
  await updatePolicy({ orgId, policyId: pausedPolicy.policyId, updates: { status: "PAUSED" }, membership: OWNER, actorEmail: ownerEmail });

  const result = await runScheduledResilienceTests({ limit: 1000 });
  assert.ok(result.completed >= 1, "at least the due, active policy created in this test must have completed");

  const { resiliencePolicies } = collections;
  const refreshedDue = await resiliencePolicies.findOne({ _id: new ObjectId(duePolicy.policyId) });
  assert.ok(refreshedDue.lastTestAt, "the due, active policy's lastTestAt must be set after the sweep");

  const refreshedPaused = await resiliencePolicies.findOne({ _id: new ObjectId(pausedPolicy.policyId) });
  assert.equal(refreshedPaused.lastTestAt, null, "a PAUSED policy must never be swept");
});
