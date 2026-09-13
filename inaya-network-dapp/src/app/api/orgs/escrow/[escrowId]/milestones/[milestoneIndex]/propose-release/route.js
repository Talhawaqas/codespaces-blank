// app/api/orgs/escrow/[escrowId]/milestones/[milestoneIndex]/propose-release/route.js
//
// POST { orgId } -- the ONLY way a milestone release ever starts. Creates
// a Guarded Execution proposal (ai-action-requests.js) rather than
// releasing anything directly -- "UI conditions alone must never be
// sufficient to release funds" (SOW §12). A human with escrow-approval
// authority must separately approve via the EXISTING
// /api/orgs/ai-actions/:requestId/review route (see
// ai-action-approval-gate.js's new ESCROW case), and even then nothing
// executes until the same 36h delay every other Guarded Execution flow
// enforces.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessEscrow } from "../../../../../../../../lib/orgs.js";
import { getEscrow } from "../../../../../../../../lib/escrow-workflow.js";
import { proposeAiAction } from "../../../../../../../../lib/ai-action-requests.js";

export async function POST(req, { params }) {
  try {
    const { escrowId, milestoneIndex } = params;
    const { orgId } = await req.json();
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!canAccessEscrow(auth.membership)) return NextResponse.json({ error: "You don't have escrow access." }, { status: 403 });

    const escrow = await getEscrow({ orgId, escrowId });
    if (!escrow) return NextResponse.json({ error: "Escrow not found." }, { status: 404 });
    const idx = Number(milestoneIndex);
    const milestone = escrow.milestones[idx];
    if (!milestone) return NextResponse.json({ error: "Milestone not found." }, { status: 404 });
    if (milestone.status !== "CONFIRMED") {
      return NextResponse.json({ error: `This milestone is ${milestone.status}, not CONFIRMED -- confirm delivery before proposing release.` }, { status: 409 });
    }

    const result = await proposeAiAction({
      orgId, assistantSurface: "human_escrow_workflow", toolName: "propose_milestone_release",
      targetRecordType: "ESCROW", targetRecordId: escrowId, proposedAction: "release",
      args: { escrowId, milestoneIndex: idx },
      requestedContextSummary: `Release ${milestone.amount} ${escrow.currency} for milestone "${milestone.description}".`,
      actorEmail: auth.session.email, canPropose: true,
    });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });

    return NextResponse.json({ requestId: result.request._id.toString(), status: result.request.status });
  } catch (err) {
    console.error("orgs/escrow milestone propose-release POST failed:", err);
    return NextResponse.json({ error: "Could not propose the release." }, { status: 500 });
  }
}
