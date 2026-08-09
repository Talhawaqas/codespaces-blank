// app/api/orgs/session/route.js
//
// GET /api/orgs/session
//
// Reads the session cookie and returns the caller's identity plus every
// org they're an active member of (with their role in each) — the
// frontend uses this on load to decide "logged out" vs "which org(s) can
// this person switch between."

import { NextResponse } from "next/server";
import { getOrgCollections, getSession, getRawSessionToken } from "../../../../lib/orgs.js";

export async function GET(req) {
  const rawToken = getRawSessionToken(req);
  const session = await getSession(rawToken);
  if (!session) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }

  const { orgMembers, orgs } = await getOrgCollections();
  const memberships = await orgMembers.find({ email: session.email, status: "active" }).toArray();
  const orgDocs = await orgs.find({ _id: { $in: memberships.map((m) => m.orgId) } }).toArray();
  const orgNameById = new Map(orgDocs.map((o) => [o._id.toString(), o.name]));

  return NextResponse.json({
    authenticated: true,
    email: session.email,
    orgs: memberships.map((m) => ({
      orgId: m.orgId.toString(),
      orgName: orgNameById.get(m.orgId.toString()) || "Unknown",
      role: m.role,
      departmentIds: (m.departmentIds || []).map((id) => id.toString()),
    })),
  });
}
