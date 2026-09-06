// app/api/orgs/private-capital/exits/[exitId]/approve/route.js
// PATCH { orgId, icDecisionId } -> only reachable from NEGOTIATION; verifies the linked IC decision is a real approval

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../../lib/industry-config.js";
import { approveExit } from "../../../../../../../lib/exit-management.js";

export async function PATCH(req, { params }) {
  try {
    const { exitId } = await params;
    const body = await req.json();
    const { orgId, icDecisionId } = body;
    if (!orgId || !icDecisionId) return NextResponse.json({ error: "orgId and icDecisionId are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "private_capital");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await approveExit({ orgId, exitId, icDecisionId, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ exit: { id: result.exit._id.toString(), status: result.exit.status, icDecisionId: result.exit.icDecisionId.toString() } });
  } catch (err) {
    console.error("orgs/private-capital/exits/[exitId]/approve PATCH failed:", err);
    return NextResponse.json({ error: "Could not approve exit." }, { status: 500 });
  }
}
