// app/api/cron/nodes-snapshot/route.js
//
// GET /api/cron/nodes-snapshot
// Node Operator Dashboard SOW — hourly telemetry-history job. Vercel Cron
// attaches Authorization: Bearer $CRON_SECRET automatically (same gate
// convention as api/nodes/settlements/release/route.js). Delegates the
// actual work to nodeUptimeHistory.js's runHourlySnapshot() -- this route
// is only the auth gate + error boundary, matching the "cron route =
// auth check + one lib call" convention used by every cron in this repo.

import { NextResponse } from "next/server";
import { runHourlySnapshot } from "../../../../lib/nodeUptimeHistory.js";

export async function GET(request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runHourlySnapshot();
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    console.error("cron/nodes-snapshot failed:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
