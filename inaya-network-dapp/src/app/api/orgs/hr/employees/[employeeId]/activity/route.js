// app/api/orgs/hr/employees/[employeeId]/activity/route.js
//
// GET /api/orgs/hr/employees/:employeeId/activity?orgId=... — HR roles or
// the employee's own record only (activity includes status-change
// history, sensitive enough to keep out of Department Manager visibility
// even though they can read the base record).

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, canAccessDepartment, canAccessHR, isSelfEmployeeRecord, toObjectId } from "../../../../../../../lib/orgs.js";
import { listOrgActivityForRecord } from "../../../../../../../lib/org-activity-log.js";

export async function GET(req, { params }) {
  try {
    const { employeeId } = params;
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { employees } = await getOrgCollections();
    const employee = await employees.findOne({ _id: toObjectId(employeeId), orgId: toObjectId(orgId) });
    if (!employee) return NextResponse.json({ error: "Employee not found." }, { status: 404 });
    const hasHR = canAccessHR(auth.membership) && canAccessDepartment(auth.membership, employee.departmentId);
    const isSelf = isSelfEmployeeRecord(employee, auth.session.email);
    if (!hasHR && !isSelf) return NextResponse.json({ error: "Employee not found." }, { status: 404 });

    const events = await listOrgActivityForRecord({ orgId, recordType: "EMPLOYEE", recordId: employeeId });
    return NextResponse.json({
      activity: events.map((e) => ({ eventId: e.eventId, actorEmail: e.actorEmail, action: e.action, previousState: e.previousState, newState: e.newState, metadata: e.metadata || {}, timestamp: e.timestamp })),
    });
  } catch (err) {
    console.error("orgs/hr/employees/[employeeId]/activity failed:", err);
    return NextResponse.json({ error: "Could not fetch employee activity." }, { status: 500 });
  }
}
