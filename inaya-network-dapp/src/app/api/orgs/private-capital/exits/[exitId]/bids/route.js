// app/api/orgs/private-capital/exits/[exitId]/bids/route.js
// POST { orgId, buyerName, buyerType, amount } -> record a bid (append-only)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../../lib/industry-config.js";
import { recordBid } from "../../../../../../../lib/exit-management.js";

export async function POST(req, { params }) {
  try {
    const { exitId } = await params;
    const body = await req.json();
    const { orgId, buyerName, buyerType, amount } = body;
    if (!orgId || !buyerName || !buyerType || typeof amount !== "number") return NextResponse.json({ error: "orgId, buyerName, buyerType, and a numeric amount are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "private_capital");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await recordBid({ orgId, exitId, buyerName, buyerType, amount, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ bids: result.exit.bids });
  } catch (err) {
    console.error("orgs/private-capital/exits/[exitId]/bids POST failed:", err);
    return NextResponse.json({ error: "Could not record bid." }, { status: 500 });
  }
}
