// app/api/orgs/private-capital/diligence/[requestId]/route.js
// PATCH { orgId, action, note? } -> start / submit / close a diligence request
//   (action "review" is handled by the sibling review/route.js, since it needs risk+conclusion, not just an action name)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../lib/industry-config.js";
import { transitionRequest } from "../../../../../../lib/due-diligence.js";

function serialize(r) {
  return { id: r._id.toString(), dealId: r.dealId.toString(), domain: r.domain, status: r.status };
}

export async function PATCH(req, { params }) {
  try {
    const { requestId } = await params;
    const { orgId, action, note } = await req.json();
    if (!orgId || !action) return NextResponse.json({ error: "orgId and action are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "private_capital");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await transitionRequest({ orgId, requestId, action, note, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ request: serialize(result.request) });
  } catch (err) {
    console.error("orgs/private-capital/diligence/[requestId] PATCH failed:", err);
    return NextResponse.json({ error: "Could not update diligence request." }, { status: 500 });
  }
}
