// app/api/orgs/private-capital/resolutions/[resolutionId]/close/route.js
// PATCH { orgId } -> tallies votes cast so far and finalizes the resolution (PASSED/FAILED)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../../lib/industry-config.js";
import { closeVoting } from "../../../../../../../lib/board-management.js";

export async function PATCH(req, { params }) {
  try {
    const { resolutionId } = await params;
    const { orgId } = await req.json();
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "private_capital");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await closeVoting({ orgId, resolutionId, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ resolution: { id: result.resolution._id.toString(), status: result.resolution.status, outcome: result.resolution.outcome } });
  } catch (err) {
    console.error("orgs/private-capital/resolutions/[resolutionId]/close PATCH failed:", err);
    return NextResponse.json({ error: "Could not close voting." }, { status: 500 });
  }
}
