// app/api/nodes/operator/login/route.js
//
// POST /api/nodes/operator/login
// Body: { walletAddress, message, signature, timestamp }
// Verifies the exact same wallet-signed action shape the CLI daemon
// already produces (nodeAuth.js's verifyNodeAuth, action:'login'), and
// requires the wallet to already be a registered node. On success, issues
// the operator dashboard's session cookie -- see nodeOperatorAuth.js's
// header comment for why this is a new, separate session layer.

import { NextResponse } from "next/server";
import { loginWithWalletSignature, NODE_SESSION_COOKIE, NODE_SESSION_COOKIE_OPTIONS } from "../../../../../lib/nodeOperatorAuth.js";

export async function POST(req) {
  try {
    const { walletAddress, message, signature, timestamp } = await req.json();
    const result = await loginWithWalletSignature({ walletAddress, message, signature, timestamp });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });

    const res = NextResponse.json({ walletAddress: result.walletAddress });
    res.cookies.set(NODE_SESSION_COOKIE, result.sessionToken, NODE_SESSION_COOKIE_OPTIONS);
    return res;
  } catch (err) {
    console.error("nodes/operator/login POST failed:", err);
    return NextResponse.json({ error: "Could not sign in." }, { status: 500 });
  }
}
