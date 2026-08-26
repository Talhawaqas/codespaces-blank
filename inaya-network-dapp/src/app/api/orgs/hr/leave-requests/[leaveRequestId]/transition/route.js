// app/api/orgs/hr/leave-requests/[leaveRequestId]/transition/route.js
//
// POST /api/orgs/hr/leave-requests/:leaveRequestId/transition
// Body: { orgId, action, note? } — action is one of: approve, reject, cancel
// (approve/reject require canManageHR; cancel is allowed for the
// requester's own PENDING request too — see leave-workflow.js.)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { transitionLeaveRequest } from "../../../../../../../lib/leave-workflow.js";

export async function POST(req, { params }) {
  try {
    const { leaveRequestId } = params;
    const { orgId, action, note } = await req.json();
    if (!orgId || !action) return NextResponse.json({ error: "orgId and action are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await transitionLeaveRequest({ orgId, leaveRequestId, action, membership: auth.membership, actorEmail: auth.session.email, note });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });

    return NextResponse.json({ status: result.leaveRequest.status, updatedAt: result.leaveRequest.updatedAt });
  } catch (err) {
    console.error("orgs/hr/leave-requests/[leaveRequestId]/transition failed:", err);
    return NextResponse.json({ error: "Could not update the leave request." }, { status: 500 });
  }
}
