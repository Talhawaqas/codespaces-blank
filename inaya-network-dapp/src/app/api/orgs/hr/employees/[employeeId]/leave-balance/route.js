// app/api/orgs/hr/employees/[employeeId]/leave-balance/route.js
//
// GET /api/orgs/hr/employees/:employeeId/leave-balance?orgId=... — HR
// roles or the employee's own record. Thin wrapper over
// leave-workflow.js's getLeaveBalance() — see that file's header comment
// for why this is computed fresh, never a stored/mutable counter.

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, canAccessDepartment, canAccessHR, isSelfEmployeeRecord, toObjectId } from "../../../../../../../lib/orgs.js";
import { getLeaveBalance } from "../../../../../../../lib/leave-workflow.js";

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

    const balance = await getLeaveBalance(orgId, employeeId);
    if (!balance) return NextResponse.json({ error: "Employee not found." }, { status: 404 });
    return NextResponse.json(balance);
  } catch (err) {
    console.error("orgs/hr/employees/[employeeId]/leave-balance failed:", err);
    return NextResponse.json({ error: "Could not fetch leave balance." }, { status: 500 });
  }
}
