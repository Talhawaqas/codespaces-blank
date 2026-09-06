// app/api/orgs/private-capital/diligence/[requestId]/review/route.js
// PATCH { orgId, risk?, conclusion } -> only reachable from SUBMITTED; sets risk/conclusion exactly once

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../../lib/industry-config.js";
import { reviewRequest } from "../../../../../../../lib/due-diligence.js";

function serialize(r) {
  return { id: r._id.toString(), status: r.status, reviewerEmail: r.reviewerEmail, risk: r.risk, conclusion: r.conclusion };
}

export async function PATCH(req, { params }) {
  try {
    const { requestId } = await params;
    const body = await req.json();
    const { orgId, conclusion } = body;
    if (!orgId || !conclusion) return NextResponse.json({ error: "orgId and conclusion are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "private_capital");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await reviewRequest({ orgId, requestId, risk: body.risk, conclusion, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ request: serialize(result.request) });
  } catch (err) {
    console.error("orgs/private-capital/diligence/[requestId]/review PATCH failed:", err);
    return NextResponse.json({ error: "Could not review diligence request." }, { status: 500 });
  }
}
