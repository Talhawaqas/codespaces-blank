// app/api/orgs/private-capital/resolutions/[resolutionId]/vote/route.js
// POST { orgId, voterEmail, vote } -> cast/replace one voter's vote (approve|reject|abstain) while voting is open

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../../lib/industry-config.js";
import { castVote } from "../../../../../../../lib/board-management.js";

export async function POST(req, { params }) {
  try {
    const { resolutionId } = await params;
    const body = await req.json();
    const { orgId, voterEmail, vote } = body;
    if (!orgId || !voterEmail || !vote) return NextResponse.json({ error: "orgId, voterEmail, and vote are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "private_capital");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await castVote({ orgId, resolutionId, voterEmail, vote, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ votes: result.resolution.votes });
  } catch (err) {
    console.error("orgs/private-capital/resolutions/[resolutionId]/vote POST failed:", err);
    return NextResponse.json({ error: "Could not cast vote." }, { status: 500 });
  }
}
