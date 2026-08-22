// app/api/security/cron/checkpoint-reputation/route.js
//
// GET /api/security/cron/checkpoint-reputation
//
// Periodic on-chain reputation checkpoint — same shared-secret cron
// philosophy as app/api/nodes/settlements/release/route.js: Vercel Cron
// attaches `Authorization: Bearer $CRON_SECRET`, checked below. Real-time
// reputation already lives off-chain (security_reputation_cache, updated
// synchronously by every confirmed threat); this route just anchors the
// current score for every "dirty" node on-chain periodically, matching
// Security Layer SOW §9's "local decisions don't wait for blockchain
// confirmation" — the chain is a tamper-evident checkpoint, not the
// live read path.
//
// Add a matching entry to vercel.json's `crons` array to schedule this
// (e.g. every 6h) the same way the settlements-release cron is wired up.

import { NextResponse } from "next/server";
import { checkpointDirtyReputations } from "../../../../../lib/security.js";

export async function GET(request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await checkpointDirtyReputations();
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    console.error("security/cron/checkpoint-reputation failed:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
