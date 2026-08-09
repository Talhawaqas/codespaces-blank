// app/api/orgs/projects/route.js
//
// GET  /api/orgs/projects?orgId=...&departmentId=...   -> projects in that department
// POST /api/orgs/projects  { orgId, departmentId, name } -> create (owner/admin only)
//
// Unlike departments, project VISIBILITY is gated by canAccessDepartment —
// a member only assigned to HR shouldn't see Finance's project list, even
// though department names themselves are org-wide visible.

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, canAccessDepartment, toObjectId } from "../../../../lib/orgs.js";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const departmentId = searchParams.get("departmentId");
    if (!orgId || !departmentId) return NextResponse.json({ error: "orgId and departmentId are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!canAccessDepartment(auth.membership, departmentId)) {
      return NextResponse.json({ error: "You don't have access to this department." }, { status: 403 });
    }

    const { projects } = await getOrgCollections();
    const list = await projects.find({ orgId: toObjectId(orgId), departmentId: toObjectId(departmentId) }).sort({ name: 1 }).toArray();

    return NextResponse.json({
      projects: list.map((p) => ({ id: p._id.toString(), name: p.name, createdAt: p.createdAt })),
    });
  } catch (err) {
    console.error("orgs/projects GET failed:", err);
    return NextResponse.json({ error: "Could not fetch projects." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const { orgId, departmentId, name: rawName } = await req.json();
    const name = String(rawName || "").trim();
    if (!orgId || !departmentId) return NextResponse.json({ error: "orgId and departmentId are required." }, { status: 400 });
    if (!name) return NextResponse.json({ error: "Project name is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { departments, projects } = await getOrgCollections();
    const orgObjectId = toObjectId(orgId);
    const departmentObjectId = toObjectId(departmentId);

    const department = await departments.findOne({ _id: departmentObjectId, orgId: orgObjectId });
    if (!department) return NextResponse.json({ error: "Department not found." }, { status: 404 });

    const existing = await projects.findOne({ orgId: orgObjectId, departmentId: departmentObjectId, name });
    if (existing) return NextResponse.json({ error: "A project with that name already exists in this department." }, { status: 409 });

    const now = new Date().toISOString();
    const result = await projects.insertOne({
      orgId: orgObjectId,
      departmentId: departmentObjectId,
      name,
      createdAt: now,
      createdByEmail: auth.session.email,
    });

    return NextResponse.json({ id: result.insertedId.toString(), name, createdAt: now });
  } catch (err) {
    console.error("orgs/projects POST failed:", err);
    return NextResponse.json({ error: "Could not create the project." }, { status: 500 });
  }
}
