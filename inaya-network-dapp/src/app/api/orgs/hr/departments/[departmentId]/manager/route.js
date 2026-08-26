// app/api/orgs/hr/departments/[departmentId]/manager/route.js
//
// POST /api/orgs/hr/departments/:departmentId/manager  { orgId, memberEmail }
//   -> org-manager-only. Adds departmentId to that member's
//      managedDepartmentIds (creating the field if absent) — "Department
//      Manager" is new (departments have no manager concept in the base
//      Business Workspace model), additive to org_members exactly like
//      financeRole/hrRole (see orgs.js's header comment on that decision).
// DELETE ?orgId=&memberEmail=  -> removes departmentId from that member's
//      managedDepartmentIds.

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, normalizeEmail, toObjectId } from "../../../../../../../lib/orgs.js";

export async function POST(req, { params }) {
  try {
    const { departmentId } = params;
    const { orgId, memberEmail: rawEmail } = await req.json();
    if (!orgId || !rawEmail) return NextResponse.json({ error: "orgId and memberEmail are required." }, { status: 400 });
    const memberEmail = normalizeEmail(rawEmail);

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { departments, orgMembers } = await getOrgCollections();
    const orgObjectId = toObjectId(orgId);
    const departmentObjectId = toObjectId(departmentId);

    const department = await departments.findOne({ _id: departmentObjectId, orgId: orgObjectId });
    if (!department) return NextResponse.json({ error: "Department not found." }, { status: 404 });
    const targetMember = await orgMembers.findOne({ orgId: orgObjectId, email: memberEmail, status: "active" });
    if (!targetMember) return NextResponse.json({ error: "That member wasn't found or isn't active." }, { status: 404 });

    await orgMembers.updateOne(
      { orgId: orgObjectId, email: memberEmail },
      { $addToSet: { managedDepartmentIds: departmentObjectId } }
    );

    return NextResponse.json({ departmentId, memberEmail, isManager: true });
  } catch (err) {
    console.error("orgs/hr/departments/[departmentId]/manager POST failed:", err);
    return NextResponse.json({ error: "Could not assign the department manager." }, { status: 500 });
  }
}

export async function DELETE(req, { params }) {
  try {
    const { departmentId } = params;
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const rawEmail = searchParams.get("memberEmail");
    if (!orgId || !rawEmail) return NextResponse.json({ error: "orgId and memberEmail are required." }, { status: 400 });
    const memberEmail = normalizeEmail(rawEmail);

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { orgMembers } = await getOrgCollections();
    const orgObjectId = toObjectId(orgId);
    const departmentObjectId = toObjectId(departmentId);

    await orgMembers.updateOne(
      { orgId: orgObjectId, email: memberEmail },
      { $pull: { managedDepartmentIds: departmentObjectId } }
    );

    return NextResponse.json({ departmentId, memberEmail, isManager: false });
  } catch (err) {
    console.error("orgs/hr/departments/[departmentId]/manager DELETE failed:", err);
    return NextResponse.json({ error: "Could not remove the department manager." }, { status: 500 });
  }
}
