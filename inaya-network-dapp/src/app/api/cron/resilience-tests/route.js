// app/api/cron/resilience-tests/route.js
//
// GET /api/cron/resilience-tests -- CRON_SECRET-gated, same Bearer-auth
// pattern as every other cron route in this app (e.g.
// api/backup/cron/check-pins/route.js). Sweeps every org's ACTIVE
// resilience policy whose test window has elapsed (schedule: daily, see
// vercel.json -- individual policies may require daily/weekly/monthly,
// so the sweep itself just needs to run at least as often as the
// shortest configured frequency).

import { NextResponse } from "next/server";
import { runScheduledResilienceTests } from "../../../../lib/resilience-orchestrator.js";

export async function GET(request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const summary = await runScheduledResilienceTests({});
    return NextResponse.json({ success: true, ...summary });
  } catch (err) {
    console.error("cron/resilience-tests failed:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
