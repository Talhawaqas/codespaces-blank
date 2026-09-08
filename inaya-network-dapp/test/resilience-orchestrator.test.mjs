// test/resilience-orchestrator.test.mjs
//
// Autonomous Resilience Layer SOW, Phase 2/4 coverage. Uses REAL Pinata/
// Filebase network calls (per the SOW's own "live verification... real
// recovery primitives where safe" requirement) -- canary creation happens
// ONCE in before() and is reused across every test below to keep real
// pinning cost/time bounded, rather than re-pinning per assertion.
//
// Run with: node --env-file=.env.local --test test/resilience-orchestrator.test.mjs
// (real network calls: expect this to take longer than a pure-Mongo test file)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { createPolicy } from "../src/lib/resilience-policy.js";
import { ensureCanaryAssets } from "../src/lib/resilience-canary.js";
import { runResilienceTest, getLatestTestRun, listTestRuns } from "../src/lib/resilience-orchestrator.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const email = (label) => `test-resilienceorch-${RUN_ID}-${label}@example.com`;
const OWNER = { role: "owner" };

let collections;
const cleanup = { orgIds: [] };
let sharedOrg;
let sharedPolicy;

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();

  const { orgs, orgMembers, departments, projects } = collections;
  const orgResult = await orgs.insertOne({ name: "Resilience Orchestrator Test Co", createdAt: new Date().toISOString() });
  cleanup.orgIds.push(orgResult.insertedId);
  const orgId = orgResult.insertedId;
  await orgMembers.insertOne({ orgId, email: email("owner"), role: "owner", departmentIds: [], status: "active", invitedAt: new Date().toISOString(), joinedAt: new Date().toISOString() });
  sharedOrg = { orgId, ownerEmail: email("owner") };

  const { policy } = await createPolicy({
    orgId, name: "Shared Test Policy", requiredRTOMinutes: 60, requiredRPOMinutes: 1440,
    criticalAssetCategories: [{ label: "Finance", priority: "CRITICAL" }],
    testFrequency: "daily", membership: OWNER, actorEmail: sharedOrg.ownerEmail,
  });
  sharedPolicy = policy;
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

test("ensureCanaryAssets: idempotent -- a second call reuses the same canary, no duplicate created", async () => {
  const first = await ensureCanaryAssets(sharedPolicy.policyId, { orgId: sharedOrg.orgId, actorEmail: sharedOrg.ownerEmail });
  assert.equal(first.canaries.length, 1);
  const firstId = first.canaries[0]._id.toString();

  const second = await ensureCanaryAssets(sharedPolicy.policyId, { orgId: sharedOrg.orgId, actorEmail: sharedOrg.ownerEmail });
  assert.equal(second.canaries.length, 1);
  assert.equal(second.canaries[0]._id.toString(), firstId, "the second call must reuse the existing canary, not create a new one");
});

test("runResilienceTest: full real pass -- real recovery, real integrity check, real permission check, PASS overall", async () => {
  const { testRun } = await runResilienceTest({ orgId: sharedOrg.orgId, policyId: sharedPolicy.policyId, membership: OWNER, actorEmail: sharedOrg.ownerEmail, triggeredBy: "manual" });
  assert.equal(testRun.status, "COMPLETED");
  assert.equal(testRun.assetResults.length, 1);
  const asset = testRun.assetResults[0];
  assert.equal(asset.recovered, true, "real reconstructAndDecrypt against real pinned replicas must succeed");
  assert.equal(asset.integrityPass, true);
  assert.equal(asset.permissionPass, true);
  assert.equal(asset.dependencyOk, true);
  assert.equal(testRun.overallResult, "PASS");
  assert.ok(testRun.actualRTOMinutes < sharedPolicy.requiredRTOMinutes, "a real single-canary test should comfortably beat a 60-minute RTO");

  const { testRun: latest } = await getLatestTestRun({ orgId: sharedOrg.orgId, policyId: sharedPolicy.policyId });
  assert.equal(latest.testRunId, testRun.testRunId);
});

test("duplicate-test prevention: a second run while one is RUNNING is rejected, not queued", async () => {
  const { resilienceTestRuns } = collections;
  const fakeRunning = await resilienceTestRuns.insertOne({
    orgId: sharedOrg.orgId, policyId: new ObjectId(sharedPolicy.policyId), status: "RUNNING",
    startedAt: new Date().toISOString(), completedAt: null, assetResults: [], triggeredBy: "manual",
  });
  const result = await runResilienceTest({ orgId: sharedOrg.orgId, policyId: sharedPolicy.policyId, membership: OWNER, actorEmail: sharedOrg.ownerEmail });
  assert.equal(result.status, 409);
  await resilienceTestRuns.deleteOne({ _id: fakeRunning.insertedId });
});

test("PASS/FAIL correctness: a tampered expectedContentHash makes an otherwise-real recovery FAIL integrity, and overall FAIL", async () => {
  const { resilienceCanaryAssets } = collections;
  await resilienceCanaryAssets.updateOne(
    { orgId: sharedOrg.orgId, policyId: new ObjectId(sharedPolicy.policyId) },
    { $set: { expectedContentHash: "0xdeadbeef00000000000000000000000000000000000000000000000000000000" } }
  );

  const { testRun } = await runResilienceTest({ orgId: sharedOrg.orgId, policyId: sharedPolicy.policyId, membership: OWNER, actorEmail: sharedOrg.ownerEmail });
  assert.equal(testRun.assetResults[0].recovered, true, "recovery itself still succeeds -- only the integrity comparison should fail");
  assert.equal(testRun.assetResults[0].integrityPass, false);
  assert.equal(testRun.overallResult, "FAIL", "one failed asset must fail the whole test run, per the SOW's worst-of-both discipline");
});

test("dependency failure: an unreachable replica (wrong providerRef) is detected, not silently skipped", async () => {
  const { resilienceCanaryAssets } = collections;
  const canary = await resilienceCanaryAssets.findOne({ orgId: sharedOrg.orgId, policyId: new ObjectId(sharedPolicy.policyId) });
  const tamperedReplicas = { ...canary.replicas, alpha: canary.replicas.alpha.map((r) => ({ ...r, providerRef: "not-a-real-providerref-000" })) };
  await resilienceCanaryAssets.updateOne({ _id: canary._id }, { $set: { replicas: tamperedReplicas } });

  const { testRun } = await runResilienceTest({ orgId: sharedOrg.orgId, policyId: sharedPolicy.policyId, membership: OWNER, actorEmail: sharedOrg.ownerEmail });
  const asset = testRun.assetResults[0];
  assert.equal(asset.dependencyOk, false, "a bogus providerRef must be reported unreachable, not silently treated as fine");
  assert.equal(testRun.overallResult, "FAIL");

  // restore for any later test in this file
  await resilienceCanaryAssets.updateOne({ _id: canary._id }, { $set: { replicas: canary.replicas } });
});

test("SECURITY: cross-org isolation -- running a test against another org's policyId/orgId combination fails closed", async () => {
  const otherOrgResult = await collections.orgs.insertOne({ name: "Other Org", createdAt: new Date().toISOString() });
  cleanup.orgIds.push(otherOrgResult.insertedId);

  const result = await runResilienceTest({ orgId: otherOrgResult.insertedId, policyId: sharedPolicy.policyId, membership: OWNER, actorEmail: email("intruder") });
  assert.equal(result.status, 404, "a policy looked up under the WRONG org must not be found, exactly like every other org-scoped lookup in this codebase");
});

test("listTestRuns: only ever returns this policy's own runs", async () => {
  const { testRuns } = await listTestRuns({ orgId: sharedOrg.orgId, policyId: sharedPolicy.policyId });
  assert.ok(testRuns.length >= 3, "every prior test in this file that completed a run should show up here");
  assert.ok(testRuns.every((r) => r.policyId === sharedPolicy.policyId));
});
