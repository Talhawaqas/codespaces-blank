// app/api/orgs/financial/valuations/[valuationId]/approve/route.js
// PATCH { orgId } -> a second, independent reviewer approves a valuation (never the recorder)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../../lib/industry-config.js";
import { approveValuation } from "../../../../../../../lib/valuation-management.js";

function serialize(v) {
  return { id: v._id.toString(), reviewerEmail: v.reviewerEmail, approvedAt: v.approvedAt };
}

export async function PATCH(req, { params }) {
  try {
    const { valuationId } = await params;
    const { orgId } = await req.json();
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "financial");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await approveValuation({ orgId, valuationId, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ valuation: serialize(result.valuation) });
  } catch (err) {
    console.error("orgs/financial/valuations/[valuationId]/approve PATCH failed:", err);
    return NextResponse.json({ error: "Could not approve valuation." }, { status: 500 });
  }
}
