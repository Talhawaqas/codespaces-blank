// app/api/orgs/legal/matter-team/route.js
// POST { orgId, matterId, memberEmail, role } -> assign a matter-team member

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../lib/industry-config.js";
import { assignMatterTeamMember } from "../../../../../lib/legal-matter-workflow.js";

export async function POST(req) {
  try {
    const { orgId, matterId, memberEmail, role } = await req.json();
    if (!orgId || !matterId || !memberEmail) return NextResponse.json({ error: "orgId, matterId, and memberEmail are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "legal");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await assignMatterTeamMember({ orgId, matterId, memberEmail, role, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ assigned: true });
  } catch (err) {
    console.error("orgs/legal/matter-team POST failed:", err);
    return NextResponse.json({ error: "Could not assign matter-team member." }, { status: 500 });
  }
}
