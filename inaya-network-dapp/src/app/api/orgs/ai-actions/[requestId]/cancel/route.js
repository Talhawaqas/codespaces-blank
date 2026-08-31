// app/api/orgs/ai-actions/[requestId]/cancel/route.js
//
// POST /api/orgs/ai-actions/:requestId/cancel — Body: { orgId }
// Allowed for the request's own approver, or any org manager (owner/
// admin), per the SOW's cancellation rule. Only works while APPROVED and
// still before unlockAt — cancelAiAction() itself enforces that with an
// atomic findOneAndUpdate guard.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canManageOrg, getOrgCollections, toObjectId } from "../../../../../../lib/orgs.js";
import { cancelAiAction } from "../../../../../../lib/ai-action-requests.js";

export async function POST(req, { params }) {
  try {
    const { requestId } = params;
    const { orgId } = await req.json();
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { aiActionRequests } = await getOrgCollections();
    const existing = await aiActionRequests.findOne({ _id: toObjectId(requestId), orgId: toObjectId(orgId) });
    if (!existing) return NextResponse.json({ error: "Request not found." }, { status: 404 });

    const canCancel = canManageOrg(auth.membership) || existing.reviewedByEmail === auth.session.email;
    if (!canCancel) return NextResponse.json({ error: "Only the approver or an org manager can cancel this." }, { status: 403 });

    const result = await cancelAiAction({ orgId, requestId, actorEmail: auth.session.email, canCancel });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });

    return NextResponse.json({ status: result.request.status });
  } catch (err) {
    console.error("orgs/ai-actions/[requestId]/cancel failed:", err);
    return NextResponse.json({ error: "Could not cancel this action request." }, { status: 500 });
  }
}
