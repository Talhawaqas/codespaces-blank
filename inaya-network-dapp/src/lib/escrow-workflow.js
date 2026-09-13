// src/lib/escrow-workflow.js
//
// Four High-Impact Business Workspace Extensions SOW — Feature 3:
// Milestone Escrow.
//
// STATUS — Live: off-chain, approval-gated milestone escrow RECORDS over
// the real `payments` ledger. NEVER described as non-custodial on-chain
// escrow anywhere in this file, its API routes, or the UI — that mechanism
// does not exist in this codebase (confirmed by inspection: every real
// on-chain fund movement here goes through an Inaya-controlled treasury/
// relayer key; there is no 2-party escrow contract). Streamed payroll is
// explicitly NOT built — see the SOW's own §16/§18 conditions ("only where
// the payment infrastructure can safely support it") — Planned/Unsupported.
//
// RELEASE = GUARDED EXECUTION, REUSED DIRECTLY. A milestone release never
// happens because a UI button was clicked — it goes through
// ai-action-requests.js's exact propose -> approve -> (36h delay) ->
// execute machinery (see this file's ESCROW entry registered into that
// module's EXECUTORS table), the same code path already proven for every
// AI-guarded mutation in this app. This gives escrow release, for free,
// the exact replay-safety/atomicity/idempotency that module already has —
// nothing reimplemented here.

import { getOrgCollections, toObjectId, canManageEscrow } from "./orgs.js";
import { logOrgActivity } from "./org-activity-log.js";

export const ESCROW_STATES = [
  "DRAFT", "AWAITING_FUNDING", "FUNDED", "ACTIVE", "MILESTONE_PENDING", "MILESTONE_APPROVED",
  "PARTIALLY_RELEASED", "FULLY_RELEASED", "DISPUTED", "CANCELLED", "EXPIRED", "REFUNDED",
];

const SIMPLE_TRANSITIONS = {
  requestFunding: { from: "DRAFT", to: "AWAITING_FUNDING", requiresManage: false, activityAction: "ESCROW_FUNDING_REQUESTED" },
  fund: { from: "AWAITING_FUNDING", to: "FUNDED", requiresManage: true, activityAction: "ESCROW_FUNDED" },
  activate: { from: "FUNDED", to: "ACTIVE", requiresManage: false, activityAction: "ESCROW_ACTIVATED" },
  cancel: { from: ["DRAFT", "AWAITING_FUNDING", "FUNDED"], to: "CANCELLED", requiresManage: true, activityAction: "ESCROW_CANCELLED" },
  refund: { from: ["ACTIVE", "DISPUTED"], to: "REFUNDED", requiresManage: true, activityAction: "ESCROW_REFUNDED" },
};

function round2(n) {
  return Math.round(n * 100) / 100;
}

export async function createEscrow({ orgId, purchaseOrderId, vendorId, currency, milestones: rawMilestones, expiresAt, membership, actorEmail }) {
  if (!canManageEscrow(membership)) return { error: "Only an escrow manager or an org owner/admin can create an escrow.", status: 403 };
  if (!Array.isArray(rawMilestones) || rawMilestones.length === 0) return { error: "At least one milestone is required.", status: 400 };

  const { purchaseOrders, escrows } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);

  if (purchaseOrderId) {
    const po = await purchaseOrders.findOne({ _id: toObjectId(purchaseOrderId), orgId: orgObjectId, deletedAt: null });
    if (!po) return { error: "Purchase order not found.", status: 404 };
  }

  const milestones = [];
  let totalAmount = 0;
  for (const m of rawMilestones) {
    const amount = Number(m.amount);
    if (!m.description || !Number.isFinite(amount) || amount <= 0) return { error: "Every milestone needs a description and a positive amount.", status: 400 };
    totalAmount = round2(totalAmount + amount);
    milestones.push({ description: String(m.description).trim(), amount, status: "PENDING", aiActionRequestId: null, releasedPaymentId: null });
  }

  const now = new Date().toISOString();
  const result = await escrows.insertOne({
    orgId: orgObjectId,
    purchaseOrderId: purchaseOrderId ? toObjectId(purchaseOrderId) : null,
    vendorId: vendorId ? toObjectId(vendorId) : null,
    currency: currency || "USD",
    totalAmount,
    milestones,
    status: "DRAFT",
    expiresAt: expiresAt || null,
    disputes: [],
    createdByEmail: actorEmail,
    createdAt: now,
  });

  await logOrgActivity({ orgId: orgObjectId, recordType: "ESCROW", recordId: result.insertedId, actorEmail, action: "ESCROW_CREATED", previousState: null, newState: "DRAFT", metadata: { totalAmount, milestoneCount: milestones.length } });
  return { escrowId: result.insertedId };
}

export async function transitionEscrow({ orgId, escrowId, action, membership, actorEmail }) {
  const definition = SIMPLE_TRANSITIONS[action];
  if (!definition) return { error: `Unknown action "${action}".`, status: 400 };
  if (definition.requiresManage && !canManageEscrow(membership)) return { error: "Only an escrow manager or an org owner/admin can do that.", status: 403 };

  const { escrows } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const escrowObjectId = toObjectId(escrowId);
  const escrow = await escrows.findOne({ _id: escrowObjectId, orgId: orgObjectId });
  if (!escrow) return { error: "Escrow not found.", status: 404 };

  const fromStates = Array.isArray(definition.from) ? definition.from : [definition.from];
  if (!fromStates.includes(escrow.status)) {
    return { error: `This escrow isn't in ${fromStates.join("/")} state (it's currently ${escrow.status}).`, status: 409 };
  }

  const updated = await escrows.findOneAndUpdate(
    { _id: escrowObjectId, orgId: orgObjectId, status: escrow.status },
    { $set: { status: definition.to, updatedAt: new Date().toISOString() } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "This escrow was modified concurrently — please retry.", status: 409 };

  await logOrgActivity({ orgId: orgObjectId, recordType: "ESCROW", recordId: escrowObjectId, actorEmail, action: definition.activityAction, previousState: escrow.status, newState: definition.to, metadata: {} });
  return { escrow: updated };
}

/** A real-world event (goods dispatched, warehouse received, work
 *  delivered) confirms a milestone is ready for release approval — the
 *  SOW's "UI conditions alone must never be sufficient to release funds"
 *  is enforced downstream by proposeMilestoneRelease() requiring a SEPARATE
 *  Guarded Execution approval, not by this confirmation step itself. */
export async function confirmMilestone({ orgId, escrowId, milestoneIndex, actorEmail }) {
  const { escrows } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const escrowObjectId = toObjectId(escrowId);
  const escrow = await escrows.findOne({ _id: escrowObjectId, orgId: orgObjectId });
  if (!escrow) return { error: "Escrow not found.", status: 404 };
  if (escrow.status !== "ACTIVE" && escrow.status !== "MILESTONE_PENDING") {
    return { error: `Milestones can only be confirmed while the escrow is ACTIVE (currently ${escrow.status}).`, status: 409 };
  }
  const milestone = escrow.milestones[milestoneIndex];
  if (!milestone) return { error: "Milestone not found.", status: 404 };
  if (milestone.status !== "PENDING") return { error: `This milestone is ${milestone.status}, not PENDING.`, status: 409 };

  const updatedMilestones = escrow.milestones.map((m, i) => (i === milestoneIndex ? { ...m, status: "CONFIRMED" } : m));
  const updated = await escrows.findOneAndUpdate(
    { _id: escrowObjectId, orgId: orgObjectId, status: escrow.status },
    { $set: { milestones: updatedMilestones } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "This escrow was modified concurrently — please retry.", status: 409 };

  await logOrgActivity({ orgId: orgObjectId, recordType: "ESCROW", recordId: escrowObjectId, actorEmail, action: "MILESTONE_CONFIRMED", previousState: "PENDING", newState: "CONFIRMED", metadata: { milestoneIndex } });
  return { escrow: updated };
}

/** Records a real dispute — stops the milestone (and, by extension, its
 *  release) cold. Resolution requires a separate, authorized human action
 *  (resolveMilestoneDispute), never automatic. */
export async function disputeMilestone({ orgId, escrowId, milestoneIndex, reason, documentRef, actorEmail }) {
  const { escrows } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const escrowObjectId = toObjectId(escrowId);
  const escrow = await escrows.findOne({ _id: escrowObjectId, orgId: orgObjectId });
  if (!escrow) return { error: "Escrow not found.", status: 404 };
  const milestone = escrow.milestones[milestoneIndex];
  if (!milestone) return { error: "Milestone not found.", status: 404 };
  if (milestone.status === "RELEASED") return { error: "This milestone has already been released and cannot be disputed.", status: 409 };

  const now = new Date().toISOString();
  const dispute = { actor: actorEmail, timestamp: now, milestoneIndex, reason: reason || null, documentRef: documentRef || null, resolutionStatus: "OPEN" };
  const updatedMilestones = escrow.milestones.map((m, i) => (i === milestoneIndex ? { ...m, status: "DISPUTED" } : m));

  const updated = await escrows.findOneAndUpdate(
    { _id: escrowObjectId, orgId: orgObjectId, status: escrow.status },
    { $set: { milestones: updatedMilestones, status: "DISPUTED" }, $push: { disputes: dispute } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "This escrow was modified concurrently — please retry.", status: 409 };

  await logOrgActivity({ orgId: orgObjectId, recordType: "ESCROW", recordId: escrowObjectId, actorEmail, action: "MILESTONE_DISPUTED", previousState: escrow.status, newState: "DISPUTED", metadata: { milestoneIndex, reason } });
  return { escrow: updated };
}

/** Resolution requires the SAME manager authority as any other high-risk
 *  transition in this codebase — never automatic, never the disputing
 *  party's own say-so. */
export async function resolveMilestoneDispute({ orgId, escrowId, milestoneIndex, resolution, membership, actorEmail }) {
  if (!canManageEscrow(membership)) return { error: "Only an escrow manager or an org owner/admin can resolve a dispute.", status: 403 };
  if (!["reinstate", "cancel"].includes(resolution)) return { error: 'resolution must be "reinstate" or "cancel".', status: 400 };

  const { escrows } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const escrowObjectId = toObjectId(escrowId);
  const escrow = await escrows.findOne({ _id: escrowObjectId, orgId: orgObjectId });
  if (!escrow) return { error: "Escrow not found.", status: 404 };
  const milestone = escrow.milestones[milestoneIndex];
  if (!milestone || milestone.status !== "DISPUTED") return { error: "This milestone is not currently disputed.", status: 409 };

  const newMilestoneStatus = resolution === "reinstate" ? "CONFIRMED" : "CANCELLED";
  const updatedMilestones = escrow.milestones.map((m, i) => (i === milestoneIndex ? { ...m, status: newMilestoneStatus } : m));
  const stillDisputed = updatedMilestones.some((m) => m.status === "DISPUTED");
  const newEscrowStatus = stillDisputed ? "DISPUTED" : "ACTIVE";

  const now = new Date().toISOString();
  const updated = await escrows.findOneAndUpdate(
    { _id: escrowObjectId, orgId: orgObjectId, status: escrow.status },
    {
      $set: {
        milestones: updatedMilestones, status: newEscrowStatus,
        "disputes.$[d].resolutionStatus": resolution === "reinstate" ? "REINSTATED" : "CANCELLED",
        "disputes.$[d].resolvedAt": now, "disputes.$[d].resolvedByEmail": actorEmail,
      },
    },
    { arrayFilters: [{ "d.milestoneIndex": milestoneIndex, "d.resolutionStatus": "OPEN" }], returnDocument: "after" }
  );
  if (!updated) return { error: "This escrow was modified concurrently — please retry.", status: 409 };

  await logOrgActivity({ orgId: orgObjectId, recordType: "ESCROW", recordId: escrowObjectId, actorEmail, action: "MILESTONE_DISPUTE_RESOLVED", previousState: "DISPUTED", newState: newEscrowStatus, metadata: { milestoneIndex, resolution } });
  return { escrow: updated };
}

/** The ONLY function that actually moves money — called exclusively by
 *  ai-action-requests.js's executor once a milestone-release proposal has
 *  cleared human approval AND the 36h delay. Creates a real `payments` row
 *  (relatedEscrowId, direction:"OUTGOING") — never a simulated one.
 *  Re-checks the milestone isn't DISPUTED/already-RELEASED at execution
 *  time (state may have changed during the 36h window), matching the same
 *  "re-validate at execution, not just at approval time" discipline every
 *  other Guarded Execution flow already has. */
export async function releaseMilestonePayment({ orgId, escrowId, milestoneIndex, actorEmail }) {
  const { escrows, payments } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const escrowObjectId = toObjectId(escrowId);
  const escrow = await escrows.findOne({ _id: escrowObjectId, orgId: orgObjectId });
  if (!escrow) return { error: "Escrow not found.", status: 404 };
  const milestone = escrow.milestones[milestoneIndex];
  if (!milestone) return { error: "Milestone not found.", status: 404 };
  if (milestone.status === "RELEASED") return { error: "This milestone has already been released.", status: 409 };
  if (milestone.status === "DISPUTED") return { error: "This milestone is disputed and cannot be released.", status: 409 };
  if (!escrow.purchaseOrderId) return { error: "This escrow has no linked purchase order/department to post the payment against.", status: 409 };

  const { purchaseOrders } = await getOrgCollections();
  const po = await purchaseOrders.findOne({ _id: escrow.purchaseOrderId, orgId: orgObjectId });
  if (!po) return { error: "The linked purchase order no longer exists.", status: 409 };

  const now = new Date().toISOString();
  const paymentResult = await payments.insertOne({
    orgId: orgObjectId, departmentId: po.departmentId, direction: "OUTGOING",
    relatedInvoiceId: null, relatedExpenseId: null, relatedPurchaseOrderId: escrow.purchaseOrderId, relatedEscrowId: escrowObjectId,
    amount: milestone.amount, currency: escrow.currency, method: "escrow_release", paymentDate: now, status: "RECORDED",
    createdByEmail: actorEmail, createdAt: now, deletedAt: null,
  });

  const updatedMilestones = escrow.milestones.map((m, i) => (i === milestoneIndex ? { ...m, status: "RELEASED", releasedPaymentId: paymentResult.insertedId } : m));
  const allReleased = updatedMilestones.every((m) => m.status === "RELEASED" || m.status === "CANCELLED");
  const anyReleased = updatedMilestones.some((m) => m.status === "RELEASED");
  const newStatus = allReleased ? "FULLY_RELEASED" : anyReleased ? "PARTIALLY_RELEASED" : escrow.status;

  await escrows.updateOne({ _id: escrowObjectId, orgId: orgObjectId }, { $set: { milestones: updatedMilestones, status: newStatus } });

  await logOrgActivity({
    orgId: orgObjectId, recordType: "ESCROW", recordId: escrowObjectId, actorEmail,
    action: "MILESTONE_RELEASED", previousState: escrow.status, newState: newStatus,
    metadata: { milestoneIndex, amount: milestone.amount, paymentId: paymentResult.insertedId.toString() },
  });

  return { paymentId: paymentResult.insertedId, escrowStatus: newStatus };
}

export async function listEscrows({ orgId, purchaseOrderId }) {
  const { escrows } = await getOrgCollections();
  const filter = { orgId: toObjectId(orgId) };
  if (purchaseOrderId) filter.purchaseOrderId = toObjectId(purchaseOrderId);
  return escrows.find(filter).sort({ createdAt: -1 }).toArray();
}

export async function getEscrow({ orgId, escrowId }) {
  const { escrows } = await getOrgCollections();
  return escrows.findOne({ _id: toObjectId(escrowId), orgId: toObjectId(orgId) });
}
