// app/api/orgs/hr/employees/[employeeId]/route.js
//
// GET single employee — HR roles, a Department Manager for that
// department, or the employee's OWN linked record (read-only self-
// access, the SOW's "Employee" role); PATCH field edits (HR roles only —
// self-access is read-only); DELETE soft-deletes (HR roles only).

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, canAccessDepartment, canAccessHR, isDepartmentManager, isSelfEmployeeRecord, normalizeEmail, toObjectId } from "../../../../../../lib/orgs.js";

function serializeEmployee(e) {
  return {
    id: e._id.toString(), orgId: e.orgId.toString(), departmentId: e.departmentId.toString(),
    memberEmail: e.memberEmail || null, fullName: e.fullName, jobTitle: e.jobTitle || null,
    employmentStatus: e.employmentStatus, joiningDate: e.joiningDate, contactEmail: e.contactEmail || null,
    contactPhone: e.contactPhone || null, annualLeaveAllocationDays: e.annualLeaveAllocationDays,
    createdByEmail: e.createdByEmail, createdAt: e.createdAt, updatedAt: e.updatedAt,
  };
}

async function loadForRead(req, orgId, employeeId) {
  await ensureOrgIndexes();
  const auth = await requireMembership(req, orgId);
  if (auth.error) return { error: auth.error, status: auth.status };

  const { employees } = await getOrgCollections();
  const employee = await employees.findOne({ _id: toObjectId(employeeId), orgId: toObjectId(orgId), deletedAt: null });
  if (!employee) return { error: "Employee not found.", status: 404 };

  const hasHR = canAccessHR(auth.membership);
  const isSelf = isSelfEmployeeRecord(employee, auth.session.email);
  const isManagerOfDept = isDepartmentManager(auth.membership, employee.departmentId);
  if (!hasHR && !isSelf && !isManagerOfDept) return { error: "Employee not found.", status: 404 };

  return { auth, employee, employees, hasHR, isSelf };
}

export async function GET(req, { params }) {
  try {
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    const result = await loadForRead(req, orgId, params.employeeId);
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(serializeEmployee(result.employee));
  } catch (err) {
    console.error("orgs/hr/employees/[employeeId] GET failed:", err);
    return NextResponse.json({ error: "Could not fetch the employee." }, { status: 500 });
  }
}

export async function PATCH(req, { params }) {
  try {
    const { orgId, fullName, jobTitle, contactEmail, contactPhone, annualLeaveAllocationDays } = await req.json();
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    const result = await loadForRead(req, orgId, params.employeeId);
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    if (!result.hasHR) return NextResponse.json({ error: "Only HR can edit employee records." }, { status: 403 });
    if (!canAccessDepartment(result.auth.membership, result.employee.departmentId)) return NextResponse.json({ error: "Employee not found." }, { status: 404 });

    const updateFields = { updatedAt: new Date().toISOString() };
    if (fullName !== undefined) {
      const trimmed = String(fullName).trim();
      if (!trimmed) return NextResponse.json({ error: "Full name cannot be empty." }, { status: 400 });
      updateFields.fullName = trimmed;
    }
    if (jobTitle !== undefined) updateFields.jobTitle = jobTitle ? String(jobTitle).trim() : null;
    if (contactEmail !== undefined) updateFields.contactEmail = contactEmail ? normalizeEmail(contactEmail) : null;
    if (contactPhone !== undefined) updateFields.contactPhone = contactPhone ? String(contactPhone).trim() : null;
    if (annualLeaveAllocationDays !== undefined) {
      if (!Number.isFinite(annualLeaveAllocationDays) || annualLeaveAllocationDays < 0) return NextResponse.json({ error: "annualLeaveAllocationDays must be a non-negative number." }, { status: 400 });
      updateFields.annualLeaveAllocationDays = annualLeaveAllocationDays;
    }

    await result.employees.updateOne({ _id: result.employee._id }, { $set: updateFields });
    const updated = await result.employees.findOne({ _id: result.employee._id });
    return NextResponse.json(serializeEmployee(updated));
  } catch (err) {
    console.error("orgs/hr/employees/[employeeId] PATCH failed:", err);
    return NextResponse.json({ error: "Could not update the employee." }, { status: 500 });
  }
}

export async function DELETE(req, { params }) {
  try {
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    const result = await loadForRead(req, orgId, params.employeeId);
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    if (!result.hasHR) return NextResponse.json({ error: "Only HR can delete employee records." }, { status: 403 });
    if (!canAccessDepartment(result.auth.membership, result.employee.departmentId)) return NextResponse.json({ error: "Employee not found." }, { status: 404 });

    await result.employees.updateOne({ _id: result.employee._id }, { $set: { deletedAt: new Date().toISOString() } });
    return NextResponse.json({ deleted: true });
  } catch (err) {
    console.error("orgs/hr/employees/[employeeId] DELETE failed:", err);
    return NextResponse.json({ error: "Could not delete the employee." }, { status: 500 });
  }
}
