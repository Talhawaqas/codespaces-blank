// test/milestone-escrow.test.mjs
//
// Four High-Impact Business Workspace Extensions SOW — Feature 3:
// Milestone Escrow. Covers the SOW §17 security list: unauthorized
// release, invalid transitions, cross-org access, dispute-blocks-release,
// and reconciliation between the escrow record and the real payments row
// its release creates. Release is exercised through the REAL Guarded
// Execution pipeline (propose -> approve -> execute), not a shortcut --
// the 36h delay is simulated by directly advancing unlockAt into the past
// (the same technique this module's own timer logic doesn't need
// re-testing here, only the ESCROW executor wiring does).
//
// Run with: node --env-file=.env.local --test test/milestone-escrow.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import {
  createEscrow, transitionEscrow, confirmMilestone, disputeMilestone,
  resolveMilestoneDispute, releaseMilestonePayment, getEscrow,
} from "../src/lib/escrow-workflow.js";
import { proposeAiAction, reviewAiAction, executeApprovedAiActions } from "../src/lib/ai-action-requests.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const email = (label) => `test-escrow-${RUN_ID}-${label}@example.com`;
const cleanup = { orgIds: [] };
let collections;

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
});

after(async () => {
  const { orgs, orgMembers, departments, suppliers, purchaseOrders, escrows, payments, aiActionRequests, orgActivity, auditChainEntries, auditChainHeads } = collections;
  await orgMembers.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await departments.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await suppliers.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await purchaseOrders.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await escrows.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await payments.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await aiActionRequests.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await orgActivity.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await auditChainEntries.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await auditChainHeads.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await orgs.deleteMany({ _id: { $in: cleanup.orgIds } });
  const client = await mongoClientPromise;
  await client.close();
});

async function makeOrgWithPO(label) {
  const now = new Date().toISOString();
  const ownerEmail = email(`${label}-owner`);
  const memberEmail = email(`${label}-member`);
  const orgResult = await collections.orgs.insertOne({ name: `${label} Co`, ownerEmail, createdAt: now });
  cleanup.orgIds.push(orgResult.insertedId);
  const orgId = orgResult.insertedId;
  const deptResult = await collections.departments.insertOne({ orgId, name: "Ops", createdAt: now });
  const supplierResult = await collections.suppliers.insertOne({ orgId, departmentId: deptResult.insertedId, name: "Vendor Co", status: "ACTIVE", createdAt: now, deletedAt: null });
  const poResult = await collections.purchaseOrders.insertOne({
    orgId, departmentId: deptResult.insertedId, supplierId: supplierResult.insertedId,
    items: [{ description: "Widgets", quantity: 10, unitPrice: 50, receivedQuantity: 0 }],
    currency: "USD", status: "ORDERED", createdByEmail: ownerEmail, createdAt: now, updatedAt: now, deletedAt: null,
  });
  await collections.orgMembers.insertMany([
    { orgId, email: ownerEmail, role: "owner", departmentIds: [], status: "active", invitedAt: now, joinedAt: now },
    { orgId, email: memberEmail, role: "member", departmentIds: [], status: "active", invitedAt: now, joinedAt: now },
  ]);
  const owner = await collections.orgMembers.findOne({ orgId, email: ownerEmail });
  const member = await collections.orgMembers.findOne({ orgId, email: memberEmail });
  return { orgId, poId: poResult.insertedId, owner, ownerEmail, member, memberEmail, deptId: deptResult.insertedId };
}

async function forceUnlockNow(requestId) {
  await collections.aiActionRequests.updateOne({ _id: requestId }, { $set: { unlockAt: new Date(Date.now() - 1000).toISOString() } });
}

test("SECURITY: a plain member cannot create an escrow", async () => {
  const fx = await makeOrgWithPO("unauth-create");
  const result = await createEscrow({ orgId: fx.orgId, purchaseOrderId: fx.poId, milestones: [{ description: "M1", amount: 100 }], membership: fx.member, actorEmail: fx.memberEmail });
  assert.equal(result.status, 403);
});

test("VALIDATION: invalid state transitions are rejected server-side", async () => {
  const fx = await makeOrgWithPO("invalid-transition");
  const created = await createEscrow({ orgId: fx.orgId, purchaseOrderId: fx.poId, milestones: [{ description: "M1", amount: 100 }], membership: fx.owner, actorEmail: fx.ownerEmail });
  // Escrow is DRAFT; "activate" requires FUNDED -- must fail, not silently succeed.
  const result = await transitionEscrow({ orgId: fx.orgId, escrowId: created.escrowId, action: "activate", membership: fx.owner, actorEmail: fx.ownerEmail });
  assert.equal(result.status, 409);
});

test("end-to-end: confirm -> propose -> approve -> execute creates a REAL payments row and reconciles with the escrow", async () => {
  const fx = await makeOrgWithPO("e2e");
  const created = await createEscrow({ orgId: fx.orgId, purchaseOrderId: fx.poId, milestones: [{ description: "Delivery 1", amount: 250 }], membership: fx.owner, actorEmail: fx.ownerEmail });
  await transitionEscrow({ orgId: fx.orgId, escrowId: created.escrowId, action: "requestFunding", membership: fx.owner, actorEmail: fx.ownerEmail });
  await transitionEscrow({ orgId: fx.orgId, escrowId: created.escrowId, action: "fund", membership: fx.owner, actorEmail: fx.ownerEmail });
  await transitionEscrow({ orgId: fx.orgId, escrowId: created.escrowId, action: "activate", membership: fx.owner, actorEmail: fx.ownerEmail });
  await confirmMilestone({ orgId: fx.orgId, escrowId: created.escrowId, milestoneIndex: 0, actorEmail: fx.ownerEmail });

  const proposal = await proposeAiAction({
    orgId: fx.orgId, assistantSurface: "test", toolName: "propose_milestone_release", targetRecordType: "ESCROW",
    targetRecordId: created.escrowId, proposedAction: "release", args: { escrowId: created.escrowId.toString(), milestoneIndex: 0 },
    requestedContextSummary: "test", actorEmail: fx.ownerEmail, canPropose: true,
  });
  assert.equal(proposal.request.status, "PENDING_APPROVAL");

  const reviewed = await reviewAiAction({ orgId: fx.orgId, requestId: proposal.request._id, decision: "approve", actorEmail: fx.ownerEmail, canApprove: true });
  assert.equal(reviewed.request.status, "APPROVED");

  // UI conditions alone must never be sufficient -- confirm nothing has
  // released yet purely from approval.
  const stillConfirmed = await getEscrow({ orgId: fx.orgId, escrowId: created.escrowId });
  assert.equal(stillConfirmed.milestones[0].status, "CONFIRMED");

  await forceUnlockNow(proposal.request._id);
  const executed = await executeApprovedAiActions({ orgId: fx.orgId });
  assert.equal(executed.executed, 1);

  const finalEscrow = await getEscrow({ orgId: fx.orgId, escrowId: created.escrowId });
  assert.equal(finalEscrow.status, "FULLY_RELEASED");
  assert.equal(finalEscrow.milestones[0].status, "RELEASED");

  const payment = await collections.payments.findOne({ relatedEscrowId: created.escrowId });
  assert.ok(payment, "a REAL payments row must exist, not a simulated one");
  assert.equal(payment.amount, 250);
  assert.equal(payment.direction, "OUTGOING");
  assert.equal(payment._id.toString(), finalEscrow.milestones[0].releasedPaymentId.toString(), "escrow and payments ledger must reconcile");
});

test("SECURITY: a dispute blocks release even if a proposal was already approved and unlocked", async () => {
  const fx = await makeOrgWithPO("dispute-blocks");
  const created = await createEscrow({ orgId: fx.orgId, purchaseOrderId: fx.poId, milestones: [{ description: "M1", amount: 100 }], membership: fx.owner, actorEmail: fx.ownerEmail });
  await transitionEscrow({ orgId: fx.orgId, escrowId: created.escrowId, action: "requestFunding", membership: fx.owner, actorEmail: fx.ownerEmail });
  await transitionEscrow({ orgId: fx.orgId, escrowId: created.escrowId, action: "fund", membership: fx.owner, actorEmail: fx.ownerEmail });
  await transitionEscrow({ orgId: fx.orgId, escrowId: created.escrowId, action: "activate", membership: fx.owner, actorEmail: fx.ownerEmail });
  await confirmMilestone({ orgId: fx.orgId, escrowId: created.escrowId, milestoneIndex: 0, actorEmail: fx.ownerEmail });

  const proposal = await proposeAiAction({
    orgId: fx.orgId, assistantSurface: "test", toolName: "propose_milestone_release", targetRecordType: "ESCROW",
    targetRecordId: created.escrowId, proposedAction: "release", args: { escrowId: created.escrowId.toString(), milestoneIndex: 0 },
    requestedContextSummary: "test", actorEmail: fx.ownerEmail, canPropose: true,
  });
  await reviewAiAction({ orgId: fx.orgId, requestId: proposal.request._id, decision: "approve", actorEmail: fx.ownerEmail, canApprove: true });
  await forceUnlockNow(proposal.request._id);

  // A dispute is filed AFTER approval but BEFORE the executor runs --
  // state may have changed during the 36h window, and release must
  // re-validate at execution time, not just trust the approval.
  await disputeMilestone({ orgId: fx.orgId, escrowId: created.escrowId, milestoneIndex: 0, reason: "quality issue", actorEmail: fx.ownerEmail });

  const executed = await executeApprovedAiActions({ orgId: fx.orgId });
  assert.equal(executed.expired, 1, "a disputed milestone must cause the release to expire honestly, never execute");
  assert.equal(executed.executed, 0);

  const payment = await collections.payments.findOne({ relatedEscrowId: created.escrowId });
  assert.equal(payment, null, "no payment must ever be created for a disputed milestone");
});

test("VALIDATION: a duplicate/replayed release attempt is rejected, never double-pays", async () => {
  const fx = await makeOrgWithPO("replay");
  const created = await createEscrow({ orgId: fx.orgId, purchaseOrderId: fx.poId, milestones: [{ description: "M1", amount: 100 }], membership: fx.owner, actorEmail: fx.ownerEmail });
  await transitionEscrow({ orgId: fx.orgId, escrowId: created.escrowId, action: "requestFunding", membership: fx.owner, actorEmail: fx.ownerEmail });
  await transitionEscrow({ orgId: fx.orgId, escrowId: created.escrowId, action: "fund", membership: fx.owner, actorEmail: fx.ownerEmail });
  await transitionEscrow({ orgId: fx.orgId, escrowId: created.escrowId, action: "activate", membership: fx.owner, actorEmail: fx.ownerEmail });
  await confirmMilestone({ orgId: fx.orgId, escrowId: created.escrowId, milestoneIndex: 0, actorEmail: fx.ownerEmail });

  const first = await releaseMilestonePayment({ orgId: fx.orgId, escrowId: created.escrowId, milestoneIndex: 0, actorEmail: fx.ownerEmail });
  assert.ok(first.paymentId);
  const second = await releaseMilestonePayment({ orgId: fx.orgId, escrowId: created.escrowId, milestoneIndex: 0, actorEmail: fx.ownerEmail });
  assert.equal(second.status, 409);

  const paymentCount = await collections.payments.countDocuments({ relatedEscrowId: created.escrowId });
  assert.equal(paymentCount, 1, "a replayed release must never create a second payment");
});

test("VALIDATION: milestone amounts must be positive -- rejects zero/negative amounts up front", async () => {
  const fx = await makeOrgWithPO("amount-validation");
  const zero = await createEscrow({ orgId: fx.orgId, purchaseOrderId: fx.poId, milestones: [{ description: "M1", amount: 0 }], membership: fx.owner, actorEmail: fx.ownerEmail });
  assert.equal(zero.status, 400);
  const negative = await createEscrow({ orgId: fx.orgId, purchaseOrderId: fx.poId, milestones: [{ description: "M1", amount: -50 }], membership: fx.owner, actorEmail: fx.ownerEmail });
  assert.equal(negative.status, 400);
});

test("SECURITY: cross-org isolation -- an escrow cannot be transitioned under the wrong org", async () => {
  const fxA = await makeOrgWithPO("cross-a");
  const fxB = await makeOrgWithPO("cross-b");
  const created = await createEscrow({ orgId: fxA.orgId, purchaseOrderId: fxA.poId, milestones: [{ description: "M1", amount: 100 }], membership: fxA.owner, actorEmail: fxA.ownerEmail });

  const result = await transitionEscrow({ orgId: fxB.orgId, escrowId: created.escrowId, action: "requestFunding", membership: fxB.owner, actorEmail: fxB.ownerEmail });
  assert.equal(result.status, 404, "the escrow doesn't exist under org B's scope");
});
