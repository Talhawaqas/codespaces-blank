// app/api/orgs/projects/[projectId]/members/route.js
//
// GET    /api/orgs/projects/:projectId/members?orgId=...        -> list
// POST   /api/orgs/projects/:projectId/members  { orgId, email } -> add (owner/admin only)
// DELETE /api/orgs/projects/:projectId/members  { orgId, email } -> remove (owner/admin only)
//
// Project-level membership (Phase 3) — separate from department membership.
// A PROJECT-accessLevel document is visible (VIEW) to anyone listed here,
// regardless of their department assignment. Gated at owner/admin the same
// way department/project creation already is — no new sub-permission
// concept introduced just for this.

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, normalizeEmail, isValidEmail, toObjectId } from "../../../../../../lib/orgs.js";

export async function GET(req, { params }) {
  try {
    const { projectId } = params;
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { projectMembers } = await getOrgCollections();
    const members = await projectMembers.find({ orgId: toObjectId(orgId), projectId: toObjectId(projectId) }).toArray();

    return NextResponse.json({ members: members.map((m) => ({ email: m.email, addedAt: m.addedAt, addedByEmail: m.addedByEmail })) });
  } catch (err) {
    console.error("orgs/projects/[projectId]/members GET failed:", err);
    return NextResponse.json({ error: "Could not fetch project members." }, { status: 500 });
  }
}

export async function POST(req, { params }) {
  try {
    const { projectId } = params;
    const { orgId, email: rawEmail } = await req.json();
    const email = normalizeEmail(rawEmail);
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    if (!email || !isValidEmail(email)) return NextResponse.json({ error: "A valid email is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { projects, orgMembers, projectMembers } = await getOrgCollections();
    const orgObjectId = toObjectId(orgId);
    const projectObjectId = toObjectId(projectId);

    const project = await projects.findOne({ _id: projectObjectId, orgId: orgObjectId });
    if (!project) return NextResponse.json({ error: "Project not found." }, { status: 404 });

    const isOrgMember = await orgMembers.findOne({ orgId: orgObjectId, email, status: "active" });
    if (!isOrgMember) return NextResponse.json({ error: "That person isn't a member of this company yet — invite them first." }, { status: 400 });

    const now = new Date().toISOString();
    await projectMembers.updateOne(
      { orgId: orgObjectId, projectId: projectObjectId, email },
      { $setOnInsert: { orgId: orgObjectId, projectId: projectObjectId, email, addedAt: now, addedByEmail: auth.session.email } },
      { upsert: true }
    );

    return NextResponse.json({ added: true });
  } catch (err) {
    console.error("orgs/projects/[projectId]/members POST failed:", err);
    return NextResponse.json({ error: "Could not add the project member." }, { status: 500 });
  }
}

export async function DELETE(req, { params }) {
  try {
    const { projectId } = params;
    const { orgId, email: rawEmail } = await req.json();
    const email = normalizeEmail(rawEmail);
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    if (!email) return NextResponse.json({ error: "email is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { projectMembers } = await getOrgCollections();
    await projectMembers.deleteOne({ orgId: toObjectId(orgId), projectId: toObjectId(projectId), email });

    return NextResponse.json({ removed: true });
  } catch (err) {
    console.error("orgs/projects/[projectId]/members DELETE failed:", err);
    return NextResponse.json({ error: "Could not remove the project member." }, { status: 500 });
  }
}
