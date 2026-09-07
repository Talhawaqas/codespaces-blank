// test/ai-regulatory-tools.test.mjs
//
// Financial Services & Regulated Enterprise SOW, Phase 6 (§199) —
// Regulatory Copilot. The load-bearing property: propose_policy_amendment
// NEVER calls amendPolicy() directly -- it only inserts a PENDING_APPROVAL
// ai_action_request. The policy is only ever actually amended after a
// human approves it and the executor sweep runs, exactly like every other
// guarded mutation in this codebase.
//
// Run with: node --env-file=.env.local --test test/ai-regulatory-tools.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import mongoClientPromise from "../src/lib/mongodb.js";
import { createControl, updateControl, linkControlToRequirement } from "../src/lib/compliance-controls.js";
import { setOrgEnabledFrameworks } from "../src/lib/compliance-frameworks.js";
import { createPolicyDraft, transitionPolicy, publishPolicy } from "../src/lib/compliance-policies.js";
import { reviewAiAction, executeApprovedAiActions } from "../src/lib/ai-action-requests.js";
import { buildRegulatoryContext, runRegulatoryTool } from "../src/lib/ai-regulatory-tools.js";

const RUN_ID = randomUUID().slice(0, 8);
const OWNER_EMAIL = `ai-regulatory-${RUN_ID}@example.com`;
const STAFF_EMAIL = `ai-regulatory-staff-${RUN_ID}@example.com`;
const MEMBERSHIP = { role: "owner", email: OWNER_EMAIL };
const STAFF_MEMBERSHIP = { role: "member", complianceRole: "staff", email: STAFF_EMAIL };
let collections;
let orgId, otherOrgId, publishedPolicyId;

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
  const now = new Date().toISOString();
  const orgResult = await collections.orgs.insertOne({ name: `AI Regulatory Test ${RUN_ID} Co`, ownerEmail: OWNER_EMAIL, vertical: "regulated", createdAt: now });
  orgId = orgResult.insertedId;
  const otherOrgResult = await collections.orgs.insertOne({ name: `AI Regulatory Test ${RUN_ID} Other Co`, ownerEmail: OWNER_EMAIL, vertical: "regulated", createdAt: now });
  otherOrgId = otherOrgResult.insertedId;

  await setOrgEnabledFrameworks({ orgId, frameworkIds: ["SOC_2"], actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const { control } = await createControl({ orgId, name: `Encryption Control ${RUN_ID}`, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  // get_enabled_frameworks_and_coverage only counts ACTIVE controls as real
  // coverage (a draft control isn't yet operational) -- activate it so this
  // fixture reflects genuine coverage, matching real-world usage.
  await updateControl({ orgId, controlId: control._id, updates: { status: "active" }, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await linkControlToRequirement({ orgId, controlId: control._id, frameworkId: "SOC_2", requirementId: "CC_SECURITY", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });

  const { policy } = await createPolicyDraft({ orgId, key: `data-retention-${RUN_ID}`, title: "Data Retention Policy", body: "Retain records for 7 years.", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await transitionPolicy({ orgId, policyId: policy._id, action: "submitForReview", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  await transitionPolicy({ orgId, policyId: policy._id, action: "approve", actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  const { policy: published } = await publishPolicy({ orgId, policyId: policy._id, actorEmail: OWNER_EMAIL, membership: MEMBERSHIP });
  publishedPolicyId = published._id;
});

after(async () => {
  await Promise.all([
    collections.orgs.deleteMany({ _id: { $in: [orgId, otherOrgId] } }),
    collections.complianceControls.deleteMany({ orgId }),
    collections.compliancePolicies.deleteMany({ orgId }),
    collections.complianceOrgFrameworks.deleteMany({ orgId }),
    collections.aiActionRequests.deleteMany({ orgId }),
    collections.orgActivity.deleteMany({ orgId }),
    collections.auditChainEntries.deleteMany({ orgId }),
    collections.auditChainHeads.deleteMany({ orgId }),
  ]);
  const client = await mongoClientPromise;
  await client.close();
});

test("get_enabled_frameworks_and_coverage reports SOC_2 enabled and correctly linked", async () => {
  const ctx = await buildRegulatoryContext({ orgId, membership: MEMBERSHIP, email: OWNER_EMAIL });
  const result = await runRegulatoryTool("get_enabled_frameworks_and_coverage", {}, ctx);
  const soc2 = result.enabledFrameworks.find((f) => f.id === "SOC_2");
  assert.ok(soc2);
  assert.equal(soc2.hasAnyLinkedControl, true);
});

test("list_control_mapping_gaps finds SOC_2 requirements with no linked control, and excludes the one that's covered", async () => {
  const ctx = await buildRegulatoryContext({ orgId, membership: MEMBERSHIP, email: OWNER_EMAIL });
  const result = await runRegulatoryTool("list_control_mapping_gaps", { frameworkId: "SOC_2" }, ctx);
  assert.ok(!result.uncoveredRequirements.some((r) => r.id === "CC_SECURITY"), "CC_SECURITY is linked and must not appear as a gap");
  assert.ok(result.uncoveredRequirements.some((r) => r.id === "CC_AVAILABILITY"), "CC_AVAILABILITY has no control and should appear as a gap");
});

test("SECURITY: check_applicability refuses a legal-advice-framed query and never returns requirements alongside the refusal", async () => {
  const ctx = await buildRegulatoryContext({ orgId, membership: MEMBERSHIP, email: OWNER_EMAIL });
  const result = await runRegulatoryTool("check_applicability", { frameworkId: "SOC_2", query: "is this a legal requirement for us" }, ctx);
  assert.equal(result.refused, true);
  assert.equal(result.requirements, undefined);
});

test("propose_policy_amendment NEVER mutates the published policy -- it only creates a PENDING_APPROVAL request", async () => {
  const ctx = await buildRegulatoryContext({ orgId, membership: STAFF_MEMBERSHIP, email: STAFF_EMAIL });
  const result = await runRegulatoryTool("propose_policy_amendment", { policyId: publishedPolicyId.toString(), body: "Retain records for 10 years.", reason: "Regulatory update" }, ctx);
  assert.equal(result.proposed, true);
  assert.match(result.message, /human review|will not take effect/i);

  const { compliancePolicies } = collections;
  const stillPublished = await compliancePolicies.findOne({ _id: publishedPolicyId });
  assert.equal(stillPublished.status, "PUBLISHED", "the AI proposing an amendment must never itself change the policy's status");
  assert.equal(stillPublished.body, "Retain records for 7 years.", "the AI proposing an amendment must never itself change the policy's content");

  const { aiActionRequests } = collections;
  const request = await aiActionRequests.findOne({ _id: new ObjectId(result.requestId) });
  assert.equal(request.status, "PENDING_APPROVAL");
  assert.equal(request.targetRecordType, "COMPLIANCE_POLICY");
  assert.equal(request.riskLevel, "HIGH");
});

test("SECURITY: a staff member without compliance access cannot even propose an amendment", async () => {
  const noAccessMembership = { role: "member", email: `no-access-${RUN_ID}@example.com` };
  const ctx = await buildRegulatoryContext({ orgId, membership: noAccessMembership, email: noAccessMembership.email });
  const result = await runRegulatoryTool("propose_policy_amendment", { policyId: publishedPolicyId.toString(), body: "Unauthorized change." }, ctx);
  assert.equal(result.status, 403);
});

test("once a compliance manager approves the proposal AND the executor sweep runs, amendPolicy() actually executes -- creating v2, never touching v1's row", async () => {
  const ctx = await buildRegulatoryContext({ orgId, membership: STAFF_MEMBERSHIP, email: STAFF_EMAIL });
  const proposeResult = await runRegulatoryTool("propose_policy_amendment", { policyId: publishedPolicyId.toString(), title: "Data Retention Policy (Updated)", body: "Retain records for 10 years per updated guidance." }, ctx);

  const { aiActionRequests, compliancePolicies } = collections;
  // Scoped by the exact request ID this call returned -- an earlier test in
  // this file also proposed an amendment against the same policy, so a
  // loose toolName/targetRecordId/status filter would ambiguously match
  // either PENDING_APPROVAL row.
  const request = await aiActionRequests.findOne({ _id: new ObjectId(proposeResult.requestId) });
  assert.ok(request);

  const approval = await reviewAiAction({ orgId, requestId: request._id, decision: "approve", actorEmail: OWNER_EMAIL, canApprove: true });
  assert.equal(approval.request.status, "APPROVED");

  // Force the unlock delay open so the executor sweep will actually pick it up now.
  await aiActionRequests.updateOne({ _id: request._id }, { $set: { unlockAt: new Date(Date.now() - 1000).toISOString() } });
  const sweep = await executeApprovedAiActions({ orgId });
  assert.equal(sweep.executed, 1);

  const v1 = await compliancePolicies.findOne({ _id: publishedPolicyId });
  assert.equal(v1.status, "AMENDED", "v1 moves to AMENDED once superseded");
  assert.equal(v1.body, "Retain records for 7 years.", "v1's content must remain exactly what it was when published -- amendment never mutates it");

  const v2 = await compliancePolicies.findOne({ orgId, supersedes: publishedPolicyId });
  assert.ok(v2, "a new v2 document must exist");
  assert.equal(v2.version, 2);
  assert.equal(v2.body, "Retain records for 10 years per updated guidance.");
  assert.equal(v2.status, "DRAFT", "the new version starts as DRAFT -- amendPolicy() does not auto-publish");
});

test("SECURITY: cross-tenant isolation -- a policy ID from org A is notFound under org B's regulatory context", async () => {
  const ctx = await buildRegulatoryContext({ orgId: otherOrgId, membership: MEMBERSHIP, email: OWNER_EMAIL });
  const result = await runRegulatoryTool("propose_policy_amendment", { policyId: publishedPolicyId.toString(), body: "Attempted cross-tenant amendment." }, ctx);
  assert.equal(result.notFound, true);
});
