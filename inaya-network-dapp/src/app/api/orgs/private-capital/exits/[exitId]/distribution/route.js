// app/api/orgs/private-capital/exits/[exitId]/distribution/route.js
// PATCH { orgId, distributionAmount } -> record a summary distribution figure (per-investor waterfall
// allocation is out of scope here -- see exit-management.js's file header)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../../lib/industry-config.js";
import { recordDistribution } from "../../../../../../../lib/exit-management.js";

export async function PATCH(req, { params }) {
  try {
    const { exitId } = await params;
    const body = await req.json();
    const { orgId, distributionAmount } = body;
    if (!orgId || typeof distributionAmount !== "number") return NextResponse.json({ error: "orgId and a numeric distributionAmount are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "private_capital");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await recordDistribution({ orgId, exitId, distributionAmount, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ exit: { id: result.exit._id.toString(), distributionAmount: result.exit.distributionAmount } });
  } catch (err) {
    console.error("orgs/private-capital/exits/[exitId]/distribution PATCH failed:", err);
    return NextResponse.json({ error: "Could not record distribution." }, { status: 500 });
  }
}
