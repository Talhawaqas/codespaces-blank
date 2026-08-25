// app/api/orgs/members/route.js
//
// GET /api/orgs/members?orgId=... — owner/admin only, for the team
// management screen (who's in, who's still pending an invite, what role
// and departments they have).

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, toObjectId } from "../../../../lib/orgs.js";

export async function GET(req) {
  try {
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { orgMembers } = await getOrgCollections();
    const list = await orgMembers.find({ orgId: toObjectId(orgId) }).sort({ invitedAt: 1 }).toArray();

    return NextResponse.json({
      members: list.map((m) => ({
        email: m.email,
        role: m.role,
        status: m.status,
        departmentIds: (m.departmentIds || []).map((id) => id.toString()),
        invitedAt: m.invitedAt,
        joinedAt: m.joinedAt || null,
        notifyOnApprovals: m.notifyOnApprovals !== false,
      })),
    });
  } catch (err) {
    console.error("orgs/members GET failed:", err);
    return NextResponse.json({ error: "Could not fetch members." }, { status: 500 });
  }
}
