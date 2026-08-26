// app/api/orgs/hr/leave-requests/route.js
//
// GET  /api/orgs/hr/leave-requests?orgId=...&employeeId=...&status=...
//   -> HR roles see everything in their accessible departments; anyone
//      else sees only their OWN requests (matching their linked employee
//      record) — self-service, the SOW's "Employee" role.
// POST /api/orgs/hr/leave-requests  { orgId, employeeId, leaveType, startDate, endDate, reason? }
//   -> create at status PENDING. The caller must either have HR access
//      to the employee's department, or the request must be for their
//      OWN linked employee record.

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, canAccessDepartment, canAccessHR, isSelfEmployeeRecord, toObjectId } from "../../../../../lib/orgs.js";
import { LEAVE_STATES } from "../../../../../lib/leave-workflow.js";

function serializeLeaveRequest(r) {
  return {
    id: r._id.toString(), orgId: r.orgId.toString(), employeeId: r.employeeId.toString(), leaveType: r.leaveType,
    startDate: r.startDate, endDate: r.endDate, reason: r.reason || null, status: r.status,
    approvedByEmail: r.approvedByEmail || null, createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const employeeId = searchParams.get("employeeId");
    const status = searchParams.get("status");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { departments, employees, leaveRequests } = await getOrgCollections();
    const orgObjectId = toObjectId(orgId);

    let list;
    if (employeeId) {
      const employee = await employees.findOne({ _id: toObjectId(employeeId), orgId: orgObjectId });
      if (!employee) return NextResponse.json({ error: "Employee not found." }, { status: 404 });
      const hasHR = canAccessHR(auth.membership) && canAccessDepartment(auth.membership, employee.departmentId);
      const isSelf = isSelfEmployeeRecord(employee, auth.session.email);
      if (!hasHR && !isSelf) return NextResponse.json({ error: "Employee not found." }, { status: 404 });
      list = await leaveRequests.find({ orgId: orgObjectId, employeeId: employee._id }).sort({ createdAt: -1 }).toArray();
    } else if (canAccessHR(auth.membership)) {
      // Avoids a second round trip through getAccessibleScope for a
      // simple listing — just resolves which departments this HR caller
      // can see directly.
      const allDepts = await departments.find({ orgId: orgObjectId }).toArray();
      const deptIds = allDepts.filter((d) => canAccessDepartment(auth.membership, d._id)).map((d) => d._id);
      const orgEmployees = deptIds.length ? await employees.find({ orgId: orgObjectId, departmentId: { $in: deptIds } }).toArray() : [];
      const empIds = orgEmployees.map((e) => e._id);
      list = empIds.length ? await leaveRequests.find({ orgId: orgObjectId, employeeId: { $in: empIds } }).sort({ createdAt: -1 }).toArray() : [];
    } else {
      const selfEmployee = await employees.findOne({ orgId: orgObjectId, memberEmail: auth.session.email, deletedAt: null });
      list = selfEmployee ? await leaveRequests.find({ orgId: orgObjectId, employeeId: selfEmployee._id }).sort({ createdAt: -1 }).toArray() : [];
    }
    if (status && LEAVE_STATES.includes(status)) list = list.filter((r) => r.status === status);

    return NextResponse.json({ leaveRequests: list.map(serializeLeaveRequest) });
  } catch (err) {
    console.error("orgs/hr/leave-requests GET failed:", err);
    return NextResponse.json({ error: "Could not fetch leave requests." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const { orgId, employeeId, leaveType: rawType, startDate, endDate, reason } = await req.json();
    const leaveType = String(rawType || "").trim();
    if (!orgId || !employeeId || !startDate || !endDate) return NextResponse.json({ error: "orgId, employeeId, startDate, and endDate are required." }, { status: 400 });
    if (!leaveType) return NextResponse.json({ error: "leaveType is required." }, { status: 400 });
    if (new Date(endDate) < new Date(startDate)) return NextResponse.json({ error: "endDate cannot be before startDate." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { employees, leaveRequests } = await getOrgCollections();
    const orgObjectId = toObjectId(orgId);
    const employeeObjectId = toObjectId(employeeId);
    const employee = await employees.findOne({ _id: employeeObjectId, orgId: orgObjectId, deletedAt: null });
    if (!employee) return NextResponse.json({ error: "Employee not found." }, { status: 404 });

    const hasHR = canAccessHR(auth.membership) && canAccessDepartment(auth.membership, employee.departmentId);
    const isSelf = isSelfEmployeeRecord(employee, auth.session.email);
    if (!hasHR && !isSelf) return NextResponse.json({ error: "You can only submit leave requests for your own employee record." }, { status: 403 });

    const now = new Date().toISOString();
    const result = await leaveRequests.insertOne({
      orgId: orgObjectId, employeeId: employeeObjectId, leaveType, startDate, endDate,
      reason: reason ? String(reason).trim() : null, status: "PENDING", approvedByEmail: null, createdAt: now, updatedAt: now,
    });

    return NextResponse.json(serializeLeaveRequest({
      _id: result.insertedId, orgId: orgObjectId, employeeId: employeeObjectId, leaveType, startDate, endDate,
      reason, status: "PENDING", createdAt: now, updatedAt: now,
    }));
  } catch (err) {
    console.error("orgs/hr/leave-requests POST failed:", err);
    return NextResponse.json({ error: "Could not create the leave request." }, { status: 500 });
  }
}
