// app/api/orgs/procurement/requests/[requestId]/transition/route.js
//
// POST /api/orgs/procurement/requests/:requestId/transition
// Body: { orgId, action, note? } — action is one of: submit, approve, reject, cancel

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { transitionPurchaseRequest } from "../../../../../../../lib/purchase-request-workflow.js";
import { notifyApprovalNeeded, notifyDecision } from "../../../../../../../lib/business-notify.js";

export async function POST(req, { params }) {
  try {
    const { requestId } = params;
    const { orgId, action, note } = await req.json();
    if (!orgId || !action) return NextResponse.json({ error: "orgId and action are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await transitionPurchaseRequest({ orgId, requestId, action, membership: auth.membership, actorEmail: auth.session.email, note });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });

    const request = result.request;
    const label = `Purchase request "${request.title}"`;
    if (action === "submit") {
      await notifyApprovalNeeded({ orgId, recordType: "PURCHASE_REQUEST", recordId: request._id, label, departmentId: request.departmentId, requesterEmail: auth.session.email });
    } else if (action === "approve" || action === "reject") {
      await notifyDecision({ orgId, recordType: "PURCHASE_REQUEST", recordId: request._id, label, targetEmail: request.createdByEmail, decision: request.status, actorEmail: auth.session.email });
    }

    return NextResponse.json({ status: request.status, updatedAt: request.updatedAt });
  } catch (err) {
    console.error("orgs/procurement/requests/[requestId]/transition failed:", err);
    return NextResponse.json({ error: "Could not update the purchase request's status." }, { status: 500 });
  }
}
