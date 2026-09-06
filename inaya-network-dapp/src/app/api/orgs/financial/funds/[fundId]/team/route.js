// app/api/orgs/financial/funds/[fundId]/team/route.js
// POST { orgId, memberEmail, role? } -> assign a fund team member

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../../lib/industry-config.js";
import { assignFundTeamMember } from "../../../../../../../lib/fund-registry.js";

export async function POST(req, { params }) {
  try {
    const { fundId } = await params;
    const body = await req.json();
    const { orgId, memberEmail } = body;
    if (!orgId || !memberEmail) return NextResponse.json({ error: "orgId and memberEmail are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, ["financial", "private_capital"]);
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await assignFundTeamMember({ orgId, fundId, memberEmail, role: body.role, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/financial/funds/[fundId]/team POST failed:", err);
    return NextResponse.json({ error: "Could not assign fund team member." }, { status: 500 });
  }
}
