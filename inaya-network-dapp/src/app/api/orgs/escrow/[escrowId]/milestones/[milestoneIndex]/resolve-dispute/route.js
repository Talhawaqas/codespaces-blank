// app/api/orgs/escrow/[escrowId]/milestones/[milestoneIndex]/resolve-dispute/route.js
// POST { orgId, resolution: "reinstate"|"cancel" } -- requires escrow-manager authority.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../../lib/orgs.js";
import { resolveMilestoneDispute } from "../../../../../../../../lib/escrow-workflow.js";

export async function POST(req, { params }) {
  try {
    const { escrowId, milestoneIndex } = params;
    const { orgId, resolution } = await req.json();
    if (!orgId || !resolution) return NextResponse.json({ error: "orgId and resolution are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await resolveMilestoneDispute({ orgId, escrowId, milestoneIndex: Number(milestoneIndex), resolution, membership: auth.membership, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ status: result.escrow.status });
  } catch (err) {
    console.error("orgs/escrow milestone resolve-dispute POST failed:", err);
    return NextResponse.json({ error: "Could not resolve the dispute." }, { status: 500 });
  }
}
