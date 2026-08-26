// app/api/orgs/hr/employees/route.js
//
// GET  /api/orgs/hr/employees?orgId=...&departmentId=...&status=...
// POST /api/orgs/hr/employees  { orgId, departmentId, fullName, jobTitle?, memberEmail?, joiningDate?, contactEmail?, contactPhone?, annualLeaveAllocationDays? }
//   -> create at status ONBOARDING. memberEmail is OPTIONAL and, if given,
//      must already be an active member of this org — "share existing
//      workspace identity... rather than creating separate user accounts"
//      (SOW §4), not a requirement that every employee has one.

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, canAccessDepartment, canAccessHR, normalizeEmail, toObjectId } from "../../../../../lib/orgs.js";
import { getAccessibleScope } from "../../../../../lib/document-permissions.js";
import { EMPLOYMENT_STATES } from "../../../../../lib/employee-workflow.js";

function serializeEmployee(e) {
  return {
    id: e._id.toString(), orgId: e.orgId.toString(), departmentId: e.departmentId.toString(),
    memberEmail: e.memberEmail || null, fullName: e.fullName, jobTitle: e.jobTitle || null,
    employmentStatus: e.employmentStatus, joiningDate: e.joiningDate, contactEmail: e.contactEmail || null,
    contactPhone: e.contactPhone || null, annualLeaveAllocationDays: e.annualLeaveAllocationDays,
    createdByEmail: e.createdByEmail, createdAt: e.createdAt, updatedAt: e.updatedAt,
  };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const departmentId = searchParams.get("departmentId");
    const status = searchParams.get("status");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    let list;
    if (departmentId) {
      if (!canAccessHR(auth.membership) && !canAccessDepartment(auth.membership, departmentId)) {
        return NextResponse.json({ error: "You don't have permission to view this." }, { status: 403 });
      }
      const { employees } = await getOrgCollections();
      list = await employees.find({ orgId: toObjectId(orgId), departmentId: toObjectId(departmentId), deletedAt: null }).sort({ createdAt: -1 }).toArray();
      // Department-scoped-but-not-HR callers (e.g. a Department Manager
      // reading their own department) still go through getAccessibleScope
      // below for the real permission decision when they lack HR access;
      // a plain canAccessDepartment pass alone isn't sufficient for HR data.
      if (!canAccessHR(auth.membership)) {
        const scope = await getAccessibleScope({ orgId, membership: auth.membership, email: auth.session.email });
        const visibleIds = new Set(scope.visibleEmployees.map((e) => e._id.toString()));
        list = list.filter((e) => visibleIds.has(e._id.toString()));
      }
    } else {
      const scope = await getAccessibleScope({ orgId, membership: auth.membership, email: auth.session.email });
      list = scope.visibleEmployees;
    }
    if (status && EMPLOYMENT_STATES.includes(status)) list = list.filter((e) => e.employmentStatus === status);

    return NextResponse.json({ employees: list.map(serializeEmployee) });
  } catch (err) {
    console.error("orgs/hr/employees GET failed:", err);
    return NextResponse.json({ error: "Could not fetch employees." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const { orgId, departmentId, fullName: rawName, jobTitle, memberEmail: rawMemberEmail, joiningDate, contactEmail, contactPhone, annualLeaveAllocationDays } = await req.json();
    const fullName = String(rawName || "").trim();
    if (!orgId || !departmentId) return NextResponse.json({ error: "orgId and departmentId are required." }, { status: 400 });
    if (!fullName) return NextResponse.json({ error: "Full name is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!canAccessDepartment(auth.membership, departmentId) || !canAccessHR(auth.membership)) {
      return NextResponse.json({ error: "You don't have permission to do that." }, { status: 403 });
    }

    const { departments, orgMembers, employees } = await getOrgCollections();
    const orgObjectId = toObjectId(orgId);
    const departmentObjectId = toObjectId(departmentId);
    const department = await departments.findOne({ _id: departmentObjectId, orgId: orgObjectId });
    if (!department) return NextResponse.json({ error: "Department not found." }, { status: 404 });

    let memberEmail = null;
    if (rawMemberEmail) {
      memberEmail = normalizeEmail(rawMemberEmail);
      const linkedMember = await orgMembers.findOne({ orgId: orgObjectId, email: memberEmail, status: "active" });
      if (!linkedMember) return NextResponse.json({ error: "memberEmail must be an active member of this company." }, { status: 400 });
      const existingLink = await employees.findOne({ orgId: orgObjectId, memberEmail, deletedAt: null });
      if (existingLink) return NextResponse.json({ error: "This member already has an employee record." }, { status: 409 });
    }

    const now = new Date().toISOString();
    const result = await employees.insertOne({
      orgId: orgObjectId, departmentId: departmentObjectId, memberEmail, fullName,
      jobTitle: jobTitle ? String(jobTitle).trim() : null, employmentStatus: "ONBOARDING",
      joiningDate: joiningDate || now, contactEmail: contactEmail ? normalizeEmail(contactEmail) : null,
      contactPhone: contactPhone ? String(contactPhone).trim() : null,
      annualLeaveAllocationDays: Number.isFinite(annualLeaveAllocationDays) ? annualLeaveAllocationDays : 20,
      createdByEmail: auth.session.email, createdAt: now, updatedAt: now, deletedAt: null,
    });

    return NextResponse.json(serializeEmployee({
      _id: result.insertedId, orgId: orgObjectId, departmentId: departmentObjectId, memberEmail, fullName, jobTitle,
      employmentStatus: "ONBOARDING", joiningDate: joiningDate || now, contactEmail, contactPhone,
      annualLeaveAllocationDays: Number.isFinite(annualLeaveAllocationDays) ? annualLeaveAllocationDays : 20,
      createdByEmail: auth.session.email, createdAt: now, updatedAt: now,
    }));
  } catch (err) {
    console.error("orgs/hr/employees POST failed:", err);
    return NextResponse.json({ error: "Could not create the employee record." }, { status: 500 });
  }
}
