// test/ai-resilience-tools.test.mjs
//
// Autonomous Resilience Layer SOW, Phase 8 coverage: the tool layer's own
// logic (policy-name matching, permission gating, ctx threading) --
// runResilienceTest() itself is already thoroughly proven against real
// data in resilience-orchestrator.test.mjs, so this file deliberately
// does NOT re-trigger a real canary/network cycle for the success path;
// it proves the tools never widen scope beyond ctx and never let a
// non-manager trigger a test.
//
// Run with: node --env-file=.env.local --test test/ai-resilience-tools.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { createPolicy } from "../src/lib/resilience-policy.js";
import { runResilienceTool } from "../src/lib/ai-resilience-tools.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const email = (label) => `test-airesilience-${RUN_ID}-${label}@example.com`;
const OWNER = { role: "owner" };
const MEMBER = { role: "member" };

let collections;
const cleanup = { orgIds: [] };

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
});

after(async () => {
  const { resiliencePolicies, orgActivity, auditChainEntries, auditChainHeads } = collections;
  await resiliencePolicies.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await orgActivity.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await auditChainEntries.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await auditChainHeads.deleteMany({ orgId: { $in: cleanup.orgIds } });
  const client = await mongoClientPromise;
  await client.close();
});

function newOrgId() {
  const id = new ObjectId();
  cleanup.orgIds.push(id);
  return id;
}

function ctxFor(orgId, membership, userEmail) {
  return { orgId, membership, email: userEmail };
}

test("get_resilience_status: an org with no policies returns an empty list, not an error", async () => {
  const orgId = newOrgId();
  const result = await runResilienceTool("get_resilience_status", {}, ctxFor(orgId, OWNER, email("a")));
  assert.deepEqual(result.policies, []);
});

test("get_resilience_status / get_last_test_result: a policy with no test yet is UNKNOWN, not fabricated as passing", async () => {
  const orgId = newOrgId();
  await createPolicy({
    orgId, name: "Untested Policy", requiredRTOMinutes: 30, requiredRPOMinutes: 15,
    criticalAssetCategories: [{ label: "Finance", priority: "CRITICAL" }], testFrequency: "daily",
    membership: OWNER, actorEmail: email("b"),
  });

  const status = await runResilienceTool("get_resilience_status", {}, ctxFor(orgId, OWNER, email("b")));
  assert.equal(status.policies[0].resilienceState, "UNKNOWN");

  const lastResult = await runResilienceTool("get_last_test_result", {}, ctxFor(orgId, OWNER, email("b")));
  assert.equal(lastResult.results[0].latestTestRun, null);
});

test("get_last_test_result: an unmatched policyName reports notFound, an ambiguous one reports its matches", async () => {
  const orgId = newOrgId();
  await createPolicy({ orgId, name: "Finance Systems", requiredRTOMinutes: 30, requiredRPOMinutes: 15, criticalAssetCategories: [{ label: "A", priority: "CRITICAL" }], testFrequency: "daily", membership: OWNER, actorEmail: email("c") });
  await createPolicy({ orgId, name: "Finance Backups", requiredRTOMinutes: 30, requiredRPOMinutes: 15, criticalAssetCategories: [{ label: "A", priority: "CRITICAL" }], testFrequency: "daily", membership: OWNER, actorEmail: email("c") });

  const notFound = await runResilienceTool("get_last_test_result", { policyName: "Nonexistent" }, ctxFor(orgId, OWNER, email("c")));
  assert.equal(notFound.notFound, true);

  const ambiguous = await runResilienceTool("get_last_test_result", { policyName: "Finance" }, ctxFor(orgId, OWNER, email("c")));
  assert.equal(ambiguous.ambiguous, true);
  assert.equal(ambiguous.matches.length, 2);
});

test("SECURITY: trigger_resilience_test_now refuses a non-manager, without even looking up the policy result", async () => {
  const orgId = newOrgId();
  await createPolicy({ orgId, name: "Guarded Policy", requiredRTOMinutes: 30, requiredRPOMinutes: 15, criticalAssetCategories: [{ label: "A", priority: "CRITICAL" }], testFrequency: "daily", membership: OWNER, actorEmail: email("d") });

  const result = await runResilienceTool("trigger_resilience_test_now", { policyName: "Guarded" }, ctxFor(orgId, MEMBER, email("d")));
  assert.ok(result.error, "a member must never be able to trigger a resilience test");
});

test("SECURITY: cross-org isolation -- get_resilience_status never sees another org's policies", async () => {
  const orgA = newOrgId();
  const orgB = newOrgId();
  await createPolicy({ orgId: orgA, name: "Org A Policy", requiredRTOMinutes: 30, requiredRPOMinutes: 15, criticalAssetCategories: [{ label: "A", priority: "CRITICAL" }], testFrequency: "daily", membership: OWNER, actorEmail: email("e") });

  const statusB = await runResilienceTool("get_resilience_status", {}, ctxFor(orgB, OWNER, email("f")));
  assert.deepEqual(statusB.policies, []);
});
