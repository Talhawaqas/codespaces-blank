// src/lib/ai-action-approval-gate.js
//
// resolveCanApprove() is the literal server-side permission-validation gate
// SOW Phase 3 asks for: per targetRecordType, it re-derives the EXACT same
// gate the real transitionX() would itself require of whoever executes it
// (Guarded Execution's core rule — an AI-proposed action can never be
// approved by someone who couldn't already do the real thing themselves).
// Lives in its own plain lib module (not inline in the review route) so it
// has no dependency on next/server and can be unit-tested directly with
// plain `node --test`, not only through an HTTP round-trip.
//
// Adding a new propose_* tool means adding one case here, not touching
// reviewAiAction()'s state machine.

import { getOrgCollections, canAccessDepartment, canManageOrg, canManageFinance, canAccessHR, canManageHR, toObjectId } from "./orgs.js";
import { getDocumentAccessLevel, meetsLevel } from "./document-permissions.js";

export async function resolveCanApprove({ orgId, targetRecordType, targetRecordId, proposedAction, membership, email }) {
  const { tasks, expenses, orgDocuments, employees, invoices, leaveRequests, purchaseOrders, purchaseRequests, crmDeals } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);

  if (targetRecordType === "TASK") {
    const task = await tasks.findOne({ _id: targetRecordId, orgId: orgObjectId });
    if (!task) return { canApprove: false, reason: "The underlying task no longer exists." };
    return { canApprove: canAccessDepartment(membership, task.departmentId) };
  }
  if (targetRecordType === "EXPENSE") {
    const expense = await expenses.findOne({ _id: targetRecordId, orgId: orgObjectId });
    if (!expense) return { canApprove: false, reason: "The underlying expense no longer exists." };
    return { canApprove: canAccessDepartment(membership, expense.departmentId) && canManageFinance(membership) };
  }
  if (targetRecordType === "DOCUMENT") {
    const doc = await orgDocuments.findOne({ _id: targetRecordId, orgId: orgObjectId });
    if (!doc) return { canApprove: false, reason: "The underlying document no longer exists." };
    // Mirrors document-workflow.js's transitionDocument() gate exactly:
    // submit/revise need EDIT-level document access, every other action
    // (startReview/approve/reject/archive/restore) needs canManageOrg.
    if (["submit", "revise"].includes(proposedAction)) {
      const accessLevel = await getDocumentAccessLevel({ orgId, doc, membership, email });
      return { canApprove: meetsLevel(accessLevel, "EDIT") };
    }
    return { canApprove: canManageOrg(membership) };
  }
  if (targetRecordType === "EMPLOYEE") {
    const employee = await employees.findOne({ _id: targetRecordId, orgId: orgObjectId });
    if (!employee) return { canApprove: false, reason: "The underlying employee record no longer exists." };
    if (!canAccessDepartment(membership, employee.departmentId) || !canAccessHR(membership)) return { canApprove: false };
    if (proposedAction === "terminate") return { canApprove: canManageHR(membership) };
    return { canApprove: true };
  }
  if (targetRecordType === "INVOICE") {
    const invoice = await invoices.findOne({ _id: targetRecordId, orgId: orgObjectId });
    if (!invoice) return { canApprove: false, reason: "The underlying invoice no longer exists." };
    return { canApprove: canAccessDepartment(membership, invoice.departmentId) && canManageFinance(membership) };
  }
  if (targetRecordType === "LEAVE_REQUEST") {
    const leaveRequest = await leaveRequests.findOne({ _id: targetRecordId, orgId: orgObjectId });
    if (!leaveRequest) return { canApprove: false, reason: "The underlying leave request no longer exists." };
    const employee = await employees.findOne({ _id: leaveRequest.employeeId, orgId: orgObjectId });
    if (!employee || !canAccessDepartment(membership, employee.departmentId)) return { canApprove: false };
    if (proposedAction === "approve" || proposedAction === "reject") return { canApprove: canManageHR(membership) };
    // cancel: HR manager, or the employee themselves — mirrors transitionLeaveRequest()'s isOwnRequest carve-out.
    return { canApprove: canManageHR(membership) || employee.memberEmail === email };
  }
  if (targetRecordType === "PURCHASE_ORDER") {
    const po = await purchaseOrders.findOne({ _id: targetRecordId, orgId: orgObjectId });
    if (!po) return { canApprove: false, reason: "The underlying purchase order no longer exists." };
    if (!canAccessDepartment(membership, po.departmentId)) return { canApprove: false };
    if (["approve", "reject"].includes(proposedAction)) return { canApprove: canManageOrg(membership) };
    return { canApprove: true };
  }
  if (targetRecordType === "PURCHASE_REQUEST") {
    const request = await purchaseRequests.findOne({ _id: targetRecordId, orgId: orgObjectId });
    if (!request) return { canApprove: false, reason: "The underlying purchase request no longer exists." };
    if (!canAccessDepartment(membership, request.departmentId)) return { canApprove: false };
    if (["approve", "reject"].includes(proposedAction)) return { canApprove: canManageOrg(membership) };
    return { canApprove: true };
  }
  if (targetRecordType === "DEAL") {
    const deal = await crmDeals.findOne({ _id: targetRecordId, orgId: orgObjectId });
    if (!deal) return { canApprove: false, reason: "The underlying deal no longer exists." };
    return { canApprove: canAccessDepartment(membership, deal.departmentId) };
  }
  return { canApprove: false, reason: `Unknown targetRecordType "${targetRecordType}".` };
}
