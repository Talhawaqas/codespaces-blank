// app/api/wallet/activity-center/route.js
//
// GET /api/wallet/activity-center?address=&period=daily|weekly|monthly|yearly
//
// Enterprise OS SOW, Phase 5. Unauthenticated — same trust tier as
// GET /api/wallet/trust-health (Phase 2): aggregate counts and bullet
// summaries only, never plaintext.

import { NextResponse } from "next/server";
import { generateWhatChanged } from "../../../../lib/activityCenter.js";

export async function GET(req) {
  try {
    const url = new URL(req.url);
    const address = url.searchParams.get("address");
    const period = url.searchParams.get("period") || "weekly";
    if (!address) return NextResponse.json({ error: "address is required." }, { status: 400 });

    const digest = await generateWhatChanged({ scope: "wallet", walletAddress: address, period });
    return NextResponse.json(digest);
  } catch (err) {
    console.error("wallet/activity-center failed:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
