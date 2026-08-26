// src/lib/employee-workflow.js
//
// Employee lifecycle — covers "onboarding" and "employee status changes"
// (SOW's HR Workflows) as real states rather than a separate checklist
// feature: ONBOARDING -> ACTIVE -> ON_LEAVE <-> ACTIVE -> TERMINATED.
// terminate requires canManageHR; the other transitions only require
// canAccessHR (HR Staff can move someone through onboarding/leave
// day-to-day, termination is a manager-level action).

import { getOrgCollections, canAccessDepartment, canAccessHR, canManageHR, toObjectId } from "./orgs.js";
import { logOrgActivity } from "./org-activity-log.js";

export const EMPLOYMENT_STATES = ["ONBOARDING", "ACTIVE", "ON_LEAVE", "TERMINATED"];

export const EMPLOYEE_TRANSITIONS = {
  activate: { from: "ONBOARDING", to: "ACTIVE", requiresManage: false, activityAction: "EMPLOYEE_ACTIVATED" },
  placeOnLeave: { from: "ACTIVE", to: "ON_LEAVE", requiresManage: false, activityAction: "EMPLOYEE_ON_LEAVE" },
  returnFromLeave: { from: "ON_LEAVE", to: "ACTIVE", requiresManage: false, activityAction: "EMPLOYEE_RETURNED" },
  terminate: { from: ["ACTIVE", "ON_LEAVE"], to: "TERMINATED", requiresManage: true, activityAction: "EMPLOYEE_TERMINATED" },
};

export async function transitionEmployee({ orgId, employeeId, action, membership, actorEmail, note }) {
  const definition = EMPLOYEE_TRANSITIONS[action];
  if (!definition) return { error: `Unknown action "${action}".`, status: 400 };

  const { employees } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const employeeObjectId = toObjectId(employeeId);

  const employee = await employees.findOne({ _id: employeeObjectId, orgId: orgObjectId, deletedAt: null });
  if (!employee) return { error: "Employee not found.", status: 404 };
  if (!canAccessDepartment(membership, employee.departmentId) || !canAccessHR(membership)) {
    return { error: "You don't have permission to do that.", status: 403 };
  }
  if (definition.requiresManage && !canManageHR(membership)) {
    return { error: "Only an HR Manager or an owner/admin can do that.", status: 403 };
  }

  const fromFilter = Array.isArray(definition.from) ? { $in: definition.from } : definition.from;
  const now = new Date().toISOString();

  const updated = await employees.findOneAndUpdate(
    { _id: employeeObjectId, orgId: orgObjectId, employmentStatus: fromFilter },
    { $set: { employmentStatus: definition.to, updatedAt: now } },
    { returnDocument: "after" }
  );
  if (!updated) {
    const expected = Array.isArray(definition.from) ? definition.from.join("/") : definition.from;
    return { error: `This employee isn't in ${expected} state (currently ${employee.employmentStatus}), so "${action}" can't be applied.`, status: 409 };
  }

  await logOrgActivity({
    orgId: orgObjectId, recordType: "EMPLOYEE", recordId: employeeObjectId, actorEmail,
    action: definition.activityAction,
    previousState: Array.isArray(definition.from) ? employee.employmentStatus : definition.from,
    newState: definition.to, metadata: note ? { note } : {},
  });

  return { employee: updated };
}
