// app/api/orgs/pending-approvals/route.js
//
// GET /api/orgs/pending-approvals
//
// Cross-org: "what's waiting on ME to approve, across every company I
// belong to" -- unlike /api/orgs/dashboard (which is scoped to one orgId
// and filters by visibility, not approval authority), this route exists
// for the desktop wrapper's tray notifications, which have no single org
// in context and need actual approval authority, not just visibility.
//
// Per document-workflow.js, startReview/approve/reject all require
// canManageOrg (org role owner/admin) -- there is no per-document or
// per-project approval grant. So membership visibility alone
// (getAccessibleScope) is the wrong filter here; a member who can merely
// see a PENDING document has no power to act on it and would get a
// meaningless notification. This route only looks at orgs where the
// caller is owner/admin.

import { NextResponse } from "next/server";
import { getOrgCollections, getSession, getRawSessionToken, canManageOrg } from "../../../../lib/orgs.js";

export async function GET(req) {
  const rawToken = getRawSessionToken(req);
  const session = await getSession(rawToken);
  if (!session) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const { orgMembers, orgs, projects, orgDocuments } = await getOrgCollections();
  const memberships = await orgMembers.find({ email: session.email, status: "active" }).toArray();
  const managerOrgIds = memberships.filter(canManageOrg).map((m) => m.orgId);

  if (managerOrgIds.length === 0) {
    return NextResponse.json({ documents: [] });
  }

  const docs = await orgDocuments
    .find({ orgId: { $in: managerOrgIds }, status: { $in: ["PENDING", "UNDER_REVIEW"] }, deletedAt: null })
    .sort({ createdAt: -1 })
    .limit(50)
    .toArray();

  const orgDocs = await orgs.find({ _id: { $in: managerOrgIds } }).toArray();
  const orgNameById = new Map(orgDocs.map((o) => [o._id.toString(), o.name]));
  const projectDocs = await projects.find({ _id: { $in: docs.map((d) => d.projectId) } }).toArray();
  const projectNameById = new Map(projectDocs.map((p) => [p._id.toString(), p.name]));

  return NextResponse.json({
    documents: docs.map((d) => ({
      id: d._id.toString(),
      filename: d.filename,
      status: d.status,
      orgId: d.orgId.toString(),
      orgName: orgNameById.get(d.orgId.toString()) || "Unknown",
      projectId: d.projectId.toString(),
      projectName: projectNameById.get(d.projectId.toString()) || "Unknown",
      createdAt: d.createdAt,
    })),
  });
}
