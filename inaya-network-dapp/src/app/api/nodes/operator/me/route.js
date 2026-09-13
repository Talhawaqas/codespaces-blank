// app/api/nodes/operator/me/route.js
//
// GET /api/nodes/operator/me — the dashboard's primary overview payload
// for the session's own (primary) wallet. Thin wrapper over
// nodeOperatorSummary.js's getNodeOperatorSummary() -- the same function
// GET /fleet calls once per linked wallet, so the two surfaces can never
// drift for the same node. Scoped entirely to the session -- there is no
// nodeId/walletAddress request parameter to manipulate.

import { NextResponse } from "next/server";
import { requireNodeSession } from "../../../../../lib/nodeOperatorAuth.js";
import { getNodeOperatorSummary } from "../../../../../lib/nodeOperatorSummary.js";

export async function GET(req) {
  try {
    const session = await requireNodeSession(req);
    if (session.error) return NextResponse.json({ error: session.error }, { status: session.status });

    const summary = await getNodeOperatorSummary(session.walletAddress);
    if (summary.error) return NextResponse.json({ error: summary.error }, { status: summary.status });

    return NextResponse.json({ primary: summary, walletAddress: session.walletAddress, linkedWallets: session.linkedWallets });
  } catch (err) {
    console.error("nodes/operator/me GET failed:", err);
    return NextResponse.json({ error: "Could not load your node." }, { status: 500 });
  }
}
