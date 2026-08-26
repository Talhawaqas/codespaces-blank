// src/lib/purchase-request-workflow.js
//
// Purchase request approval state machine — same transition-table pattern
// as document-workflow.js/task-workflow.js. A request is the lightweight
// "can we buy this" ask; once APPROVED it can be converted into a full
// purchase_order (see purchase-order-workflow.js's createPurchaseOrder,
// which records sourceRequestId) — conversion is a separate, explicit
// action, not an automatic side effect of approval, since not every
// approved request becomes a PO on the same day or through the same flow.

import { getOrgCollections, canAccessDepartment, canManageOrg, toObjectId } from "./orgs.js";
import { logOrgActivity } from "./org-activity-log.js";

export const PURCHASE_REQUEST_STATES = ["DRAFT", "PENDING_APPROVAL", "APPROVED", "REJECTED", "CANCELLED"];

export const PR_TRANSITIONS = {
  submit: { from: "DRAFT", to: "PENDING_APPROVAL", requiresManage: false, activityAction: "REQUEST_SUBMITTED" },
  approve: { from: "PENDING_APPROVAL", to: "APPROVED", requiresManage: true, activityAction: "REQUEST_APPROVED" },
  reject: { from: "PENDING_APPROVAL", to: "REJECTED", requiresManage: true, activityAction: "REQUEST_REJECTED" },
  cancel: { from: ["DRAFT", "PENDING_APPROVAL"], to: "CANCELLED", requiresManage: false, activityAction: "REQUEST_CANCELLED" },
};

export async function transitionPurchaseRequest({ orgId, requestId, action, membership, actorEmail, note }) {
  const definition = PR_TRANSITIONS[action];
  if (!definition) return { error: `Unknown action "${action}".`, status: 400 };

  const { purchaseRequests } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const requestObjectId = toObjectId(requestId);

  const request = await purchaseRequests.findOne({ _id: requestObjectId, orgId: orgObjectId, deletedAt: null });
  if (!request) return { error: "Purchase request not found.", status: 404 };
  if (!canAccessDepartment(membership, request.departmentId)) {
    return { error: "You don't have permission to do that.", status: 403 };
  }
  if (definition.requiresManage && !canManageOrg(membership)) {
    return { error: "Only the owner or an admin can do that.", status: 403 };
  }

  const fromFilter = Array.isArray(definition.from) ? { $in: definition.from } : definition.from;
  const now = new Date().toISOString();

  const updated = await purchaseRequests.findOneAndUpdate(
    { _id: requestObjectId, orgId: orgObjectId, status: fromFilter },
    { $set: { status: definition.to, updatedAt: now } },
    { returnDocument: "after" }
  );
  if (!updated) {
    const expected = Array.isArray(definition.from) ? definition.from.join("/") : definition.from;
    return { error: `This request isn't in ${expected} state (it's currently ${request.status}), so "${action}" can't be applied.`, status: 409 };
  }

  await logOrgActivity({
    orgId: orgObjectId,
    recordType: "PURCHASE_REQUEST",
    recordId: requestObjectId,
    actorEmail,
    action: definition.activityAction,
    previousState: Array.isArray(definition.from) ? request.status : definition.from,
    newState: definition.to,
    metadata: note ? { note } : {},
  });

  return { request: updated };
}
