// test/resilience-policy.test.mjs
//
// Autonomous Resilience Layer SOW, Phase 1 coverage: policy CRUD
// validation, manage-only gating, cross-org isolation, and the SOW's own
// literal RTO/RPO comparison rule.
//
// Run with: node --env-file=.env.local --test test/resilience-policy.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { createPolicy, updatePolicy, getPolicy, listPolicies, evaluateRtoRpo } from "../src/lib/resilience-policy.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const email = (label) => `test-resiliencepolicy-${RUN_ID}-${label}@example.com`;
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

const validInput = {
  name: "Core Financial Systems",
  requiredRTOMinutes: 30,
  requiredRPOMinutes: 15,
  criticalAssetCategories: [{ label: "Finance", priority: "CRITICAL" }, { label: "HR", priority: "HIGH" }],
  testFrequency: "daily",
};

test("createPolicy: requires manage, validates every field", async () => {
  const orgId = newOrgId();
  const notManager = await createPolicy({ orgId, ...validInput, membership: MEMBER, actorEmail: email("a") });
  assert.equal(notManager.status, 403);

  const badRto = await createPolicy({ orgId, ...validInput, requiredRTOMinutes: -5, membership: OWNER, actorEmail: email("a") });
  assert.equal(badRto.status, 400);

  const badFrequency = await createPolicy({ orgId, ...validInput, testFrequency: "hourly", membership: OWNER, actorEmail: email("a") });
  assert.equal(badFrequency.status, 400);

  const noCategories = await createPolicy({ orgId, ...validInput, criticalAssetCategories: [], membership: OWNER, actorEmail: email("a") });
  assert.equal(noCategories.status, 400);

  const ok = await createPolicy({ orgId, ...validInput, membership: OWNER, actorEmail: email("a") });
  assert.equal(ok.policy.status, "ACTIVE");
  assert.equal(ok.policy.criticalAssetCategories.length, 2);
});

test("updatePolicy: can pause/resume and change thresholds, still manage-gated", async () => {
  const orgId = newOrgId();
  const { policy } = await createPolicy({ orgId, ...validInput, membership: OWNER, actorEmail: email("b") });

  const denied = await updatePolicy({ orgId, policyId: policy.policyId, updates: { status: "PAUSED" }, membership: MEMBER, actorEmail: email("b") });
  assert.equal(denied.status, 403);

  const paused = await updatePolicy({ orgId, policyId: policy.policyId, updates: { status: "PAUSED" }, membership: OWNER, actorEmail: email("b") });
  assert.equal(paused.policy.status, "PAUSED");

  const retightened = await updatePolicy({ orgId, policyId: policy.policyId, updates: { requiredRTOMinutes: 10 }, membership: OWNER, actorEmail: email("b") });
  assert.equal(retightened.policy.requiredRTOMinutes, 10);
  assert.equal(retightened.policy.requiredRPOMinutes, validInput.requiredRPOMinutes, "unspecified fields must be preserved, not wiped");
});

test("SECURITY: cross-org isolation -- getPolicy/listPolicies never leak across orgs", async () => {
  const orgA = newOrgId();
  const orgB = newOrgId();
  const { policy } = await createPolicy({ orgId: orgA, ...validInput, membership: OWNER, actorEmail: email("c") });

  const wrongOrg = await getPolicy({ orgId: orgB, policyId: policy.policyId });
  assert.equal(wrongOrg.status, 404);

  const { policies } = await listPolicies({ orgId: orgB });
  assert.equal(policies.length, 0);
});

test("evaluateRtoRpo: the SOW's literal Actual <= Required rule, both dimensions independent", () => {
  const policy = { requiredRTOMinutes: 30, requiredRPOMinutes: 15 };
  assert.deepEqual(evaluateRtoRpo(policy, 18, 11), { rtoPass: true, rpoPass: true, overallPass: true });
  assert.deepEqual(evaluateRtoRpo(policy, 45, 11), { rtoPass: false, rpoPass: true, overallPass: false });
  assert.deepEqual(evaluateRtoRpo(policy, 18, 20), { rtoPass: true, rpoPass: false, overallPass: false });
  assert.deepEqual(evaluateRtoRpo(policy, 30, 15), { rtoPass: true, rpoPass: true, overallPass: true }, "exactly at the threshold is a PASS, not a FAIL");
});
