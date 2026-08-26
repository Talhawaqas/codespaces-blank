// src/lib/leave-workflow.js
//
// Leave request approval + the computed leave balance. Balance is
// DERIVED, never a mutable stored counter — employees.annualLeaveAllocationDays
// (HR-editable, default 20) minus the sum of THIS YEAR's APPROVED leave
// request day-spans, computed fresh on every read. Same "ledger is truth,
// a balance is just a cached sum" discipline inventory.js's stock levels
// and faucet.js's lifetime-cap tracking already established elsewhere in
// this codebase — a mutable counter risks silent drift (a request
// approved then later cancelled, a manual balance edit that falls out of
// sync); recomputing from the real leave_requests history never can.
//
// ACCESS: approve/reject require canManageHR. Any employee can create/
// view/cancel their OWN leave requests (self-service — the SOW's
// "Employee" role), checked by the caller matching leaveRequest against
// their own employeeId, not by this file (see the API route).

import { getOrgCollections, canAccessDepartment, canManageHR, toObjectId } from "./orgs.js";
import { logOrgActivity } from "./org-activity-log.js";

export const LEAVE_STATES = ["PENDING", "APPROVED", "REJECTED", "CANCELLED"];
const DEFAULT_ANNUAL_ALLOCATION_DAYS = 20;

function daySpan(startDate, endDate) {
  const ms = new Date(endDate).getTime() - new Date(startDate).getTime();
  return Math.max(1, Math.round(ms / (24 * 60 * 60 * 1000)) + 1); // inclusive of both ends
}

/** Real balance for one employee, computed fresh — see header comment. */
export async function getLeaveBalance(orgId, employeeId) {
  const { employees, leaveRequests } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const employeeObjectId = toObjectId(employeeId);

  const employee = await employees.findOne({ _id: employeeObjectId, orgId: orgObjectId });
  if (!employee) return null;

  const allocation = employee.annualLeaveAllocationDays ?? DEFAULT_ANNUAL_ALLOCATION_DAYS;
  const yearStart = `${new Date().getFullYear()}-01-01`;
  const approvedThisYear = await leaveRequests
    .find({ orgId: orgObjectId, employeeId: employeeObjectId, status: "APPROVED", startDate: { $gte: yearStart } })
    .toArray();

  const daysUsed = approvedThisYear.reduce((sum, r) => sum + daySpan(r.startDate, r.endDate), 0);
  return { allocationDays: allocation, usedDays: daysUsed, remainingDays: Math.max(0, allocation - daysUsed) };
}

export async function transitionLeaveRequest({ orgId, leaveRequestId, action, membership, actorEmail, note }) {
  const { leaveRequests, employees } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const leaveObjectId = toObjectId(leaveRequestId);

  const leaveRequest = await leaveRequests.findOne({ _id: leaveObjectId, orgId: orgObjectId });
  if (!leaveRequest) return { error: "Leave request not found.", status: 404 };

  const employee = await employees.findOne({ _id: leaveRequest.employeeId, orgId: orgObjectId });
  if (!employee) return { error: "Leave request not found.", status: 404 };
  if (!canAccessDepartment(membership, employee.departmentId)) return { error: "You don't have permission to do that.", status: 403 };

  const isOwnRequest = employee.memberEmail === actorEmail;
  let to;
  let activityAction;
  if (action === "approve" || action === "reject") {
    if (!canManageHR(membership)) return { error: "Only an HR Manager or an owner/admin can do that.", status: 403 };
    if (leaveRequest.status !== "PENDING") return { error: `This request isn't PENDING (it's ${leaveRequest.status}).`, status: 409 };
    to = action === "approve" ? "APPROVED" : "REJECTED";
    activityAction = action === "approve" ? "LEAVE_APPROVED" : "LEAVE_REJECTED";
  } else if (action === "cancel") {
    if (!canManageHR(membership) && !isOwnRequest) return { error: "You can only cancel your own leave request.", status: 403 };
    if (leaveRequest.status !== "PENDING") return { error: `This request isn't PENDING (it's ${leaveRequest.status}).`, status: 409 };
    to = "CANCELLED";
    activityAction = "LEAVE_CANCELLED";
  } else {
    return { error: `Unknown action "${action}".`, status: 400 };
  }

  const now = new Date().toISOString();
  const updated = await leaveRequests.findOneAndUpdate(
    { _id: leaveObjectId, orgId: orgObjectId, status: "PENDING" },
    { $set: { status: to, approvedByEmail: (to === "APPROVED" || to === "REJECTED") ? actorEmail : leaveRequest.approvedByEmail, updatedAt: now } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "This leave request's status changed since it was loaded — reload and try again.", status: 409 };

  await logOrgActivity({
    orgId: orgObjectId, recordType: "LEAVE_REQUEST", recordId: leaveObjectId, actorEmail,
    action: activityAction, previousState: "PENDING", newState: to, metadata: note ? { note } : {},
  });

  return { leaveRequest: updated };
}
