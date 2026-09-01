// app/api/orgs/ai-actions/[requestId]/review/route.js
//
// POST /api/orgs/ai-actions/:requestId/review
// Body: { orgId, decision: "approve"|"reject", note? }
//
// canApprove is resolved HERE, server-side, per targetRecordType — the
// exact same gate the real transitionX() would itself require of whoever
// executes it, per Guarded Execution's core rule (an AI-proposed action
// can never be approved by someone who couldn't already do the real
// thing themselves). Adding a new propose_* tool in the future means
// adding one case here, not touching reviewAiAction()'s state machine.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, getOrgCollections, toObjectId } from "../../../../../../lib/orgs.js";
import { resolveCanApprove } from "../../../../../../lib/ai-action-approval-gate.js";
import { reviewAiAction } from "../../../../../../lib/ai-action-requests.js";

export async function POST(req, { params }) {
  try {
    const { requestId } = params;
    const { orgId, decision, note } = await req.json();
    if (!orgId || !decision) return NextResponse.json({ error: "orgId and decision are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { aiActionRequests } = await getOrgCollections();
    const existing = await aiActionRequests.findOne({ _id: toObjectId(requestId), orgId: toObjectId(orgId) });
    if (!existing) return NextResponse.json({ error: "Request not found." }, { status: 404 });

    const { canApprove, reason } = await resolveCanApprove({
      orgId, targetRecordType: existing.targetRecordType, targetRecordId: existing.targetRecordId,
      proposedAction: existing.proposedAction, membership: auth.membership, email: auth.session.email,
    });
    if (!canApprove) return NextResponse.json({ error: reason || "You don't have permission to review this action." }, { status: 403 });

    const result = await reviewAiAction({ orgId, requestId, decision, actorEmail: auth.session.email, note, canApprove });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });

    return NextResponse.json({ status: result.request.status, unlockAt: result.request.unlockAt });
  } catch (err) {
    console.error("orgs/ai-actions/[requestId]/review failed:", err);
    return NextResponse.json({ error: "Could not review this action request." }, { status: 500 });
  }
}
