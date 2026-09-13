// app/api/orgs/escrow/[escrowId]/transition/route.js
// POST /api/orgs/escrow/:escrowId/transition  { orgId, action }
// action: requestFunding | fund | activate | cancel | refund

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../lib/orgs.js";
import { transitionEscrow } from "../../../../../../lib/escrow-workflow.js";

export async function POST(req, { params }) {
  try {
    const { escrowId } = params;
    const { orgId, action } = await req.json();
    if (!orgId || !action) return NextResponse.json({ error: "orgId and action are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await transitionEscrow({ orgId, escrowId, action, membership: auth.membership, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ status: result.escrow.status });
  } catch (err) {
    console.error("orgs/escrow/[escrowId]/transition POST failed:", err);
    return NextResponse.json({ error: "Could not update the escrow." }, { status: 500 });
  }
}
