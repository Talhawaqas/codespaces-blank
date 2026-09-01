// app/api/backup/cron/verify-integrity/route.js
//
// GET /api/backup/cron/verify-integrity -- CRON_SECRET-gated. Tier 2 of the SOW's
// failure-detection requirement: actual content fetch + SHA-256 comparison against the hash
// captured at pin time, batched/rotated (oldest-checked-first, bounded per run) so a large asset
// base isn't fully re-fetched every day (schedule: once daily, see vercel.json). A mismatch is
// real corruption and is never given grace, unlike Tier-1 pin-status misses.

import { NextResponse } from "next/server";
import { runVerifyIntegritySweep } from "../../../../../lib/backupEngine";

export async function GET(request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const summary = await runVerifyIntegritySweep({});
    return NextResponse.json({ success: true, ...summary });
  } catch (err) {
    console.error("backup/cron/verify-integrity failed:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
