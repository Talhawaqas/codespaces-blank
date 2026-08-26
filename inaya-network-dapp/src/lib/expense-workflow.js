// src/lib/expense-workflow.js
//
// Expense approval state machine — near-identical structure to
// purchase-request-workflow.js's DRAFT->PENDING_APPROVAL->APPROVED|REJECTED
// shape, since "record an expense, get it approved" is the same kind of
// lightweight approval flow as a purchase request. approve/reject require
// canManageFinance; submit/cancel only require canAccessFinance (any
// Finance Staff can submit their own expense for approval).

import { getOrgCollections, canAccessDepartment, canAccessFinance, canManageFinance, toObjectId } from "./orgs.js";
import { logOrgActivity } from "./org-activity-log.js";

export const EXPENSE_STATES = ["DRAFT", "PENDING_APPROVAL", "APPROVED", "REJECTED", "CANCELLED"];

export const EXPENSE_TRANSITIONS = {
  submit: { from: "DRAFT", to: "PENDING_APPROVAL", requiresManage: false, activityAction: "EXPENSE_SUBMITTED" },
  approve: { from: "PENDING_APPROVAL", to: "APPROVED", requiresManage: true, activityAction: "EXPENSE_APPROVED" },
  reject: { from: "PENDING_APPROVAL", to: "REJECTED", requiresManage: true, activityAction: "EXPENSE_REJECTED" },
  cancel: { from: ["DRAFT", "PENDING_APPROVAL"], to: "CANCELLED", requiresManage: false, activityAction: "EXPENSE_CANCELLED" },
};

export async function transitionExpense({ orgId, expenseId, action, membership, actorEmail, note }) {
  const definition = EXPENSE_TRANSITIONS[action];
  if (!definition) return { error: `Unknown action "${action}".`, status: 400 };

  const { expenses } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const expenseObjectId = toObjectId(expenseId);

  const expense = await expenses.findOne({ _id: expenseObjectId, orgId: orgObjectId, deletedAt: null });
  if (!expense) return { error: "Expense not found.", status: 404 };
  if (!canAccessDepartment(membership, expense.departmentId) || !canAccessFinance(membership)) {
    return { error: "You don't have permission to do that.", status: 403 };
  }
  if (definition.requiresManage && !canManageFinance(membership)) {
    return { error: "Only a Finance Manager or an owner/admin can do that.", status: 403 };
  }

  const fromFilter = Array.isArray(definition.from) ? { $in: definition.from } : definition.from;
  const now = new Date().toISOString();

  const updated = await expenses.findOneAndUpdate(
    { _id: expenseObjectId, orgId: orgObjectId, status: fromFilter },
    { $set: { status: definition.to, updatedAt: now } },
    { returnDocument: "after" }
  );
  if (!updated) {
    const expected = Array.isArray(definition.from) ? definition.from.join("/") : definition.from;
    return { error: `This expense isn't in ${expected} state (it's currently ${expense.status}), so "${action}" can't be applied.`, status: 409 };
  }

  await logOrgActivity({
    orgId: orgObjectId, recordType: "EXPENSE", recordId: expenseObjectId, actorEmail,
    action: definition.activityAction,
    previousState: Array.isArray(definition.from) ? expense.status : definition.from,
    newState: definition.to, metadata: note ? { note } : {},
  });

  return { expense: updated };
}
