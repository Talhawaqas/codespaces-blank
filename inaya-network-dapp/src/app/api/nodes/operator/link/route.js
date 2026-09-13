// app/api/nodes/operator/link/route.js
//
// POST /api/nodes/operator/link
// Body: { walletAddress, message, signature, timestamp } -- for the wallet
// being linked, signed by THAT wallet's own owner (not the primary session
// wallet). Enables the optional fleet view (SOW §15-16) for an operator
// running more than one node, without inventing a new operator-account
// concept -- see nodeOperatorAuth.js's linkWalletToSession().

import { NextResponse } from "next/server";
import { requireNodeSession, linkWalletToSession } from "../../../../../lib/nodeOperatorAuth.js";

export async function POST(req) {
  try {
    const session = await requireNodeSession(req);
    if (session.error) return NextResponse.json({ error: session.error }, { status: session.status });

    const { walletAddress, message, signature, timestamp } = await req.json();
    const result = await linkWalletToSession(session.sessionDoc, { walletAddress, message, signature, timestamp });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });

    return NextResponse.json(result);
  } catch (err) {
    console.error("nodes/operator/link POST failed:", err);
    return NextResponse.json({ error: "Could not link this wallet." }, { status: 500 });
  }
}
