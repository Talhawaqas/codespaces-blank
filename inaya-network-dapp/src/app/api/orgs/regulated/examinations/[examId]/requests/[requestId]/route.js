// app/api/orgs/regulated/examinations/[examId]/requests/[requestId]/route.js
// PATCH { orgId, action: "respond", response } -> internal owner submits their response
// PATCH { orgId, action: "approve"|"reject", reviewerComments? } -> audit manager reviews the response

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../../../lib/industry-config.js";
import { respondToRequest, approveResponse } from "../../../../../../../../lib/regulatory-examination.js";

function serialize(r) {
  return { id: r._id.toString(), status: r.status, response: r.response, reviewerComments: r.reviewerComments };
}

export async function PATCH(req, { params }) {
  try {
    const { requestId } = await params;
    const body = await req.json();
    const { orgId, action } = body;
    if (!orgId || !action) return NextResponse.json({ error: "orgId and action are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "regulated");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    let result;
    if (action === "respond") {
      result = await respondToRequest({ orgId, requestId, response: body.response, actorEmail: auth.session.email });
    } else if (action === "approve" || action === "reject") {
      result = await approveResponse({ orgId, requestId, approve: action === "approve", reviewerComments: body.reviewerComments, actorEmail: auth.session.email, membership: auth.membership });
    } else {
      return NextResponse.json({ error: `Unknown action "${action}".` }, { status: 400 });
    }
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ request: serialize(result.request) });
  } catch (err) {
    console.error("orgs/regulated/examinations/[examId]/requests/[requestId] PATCH failed:", err);
    return NextResponse.json({ error: "Could not update request." }, { status: 500 });
  }
}
