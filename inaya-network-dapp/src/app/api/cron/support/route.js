// app/api/cron/support/route.js
//
// GET /api/cron/support -- SLA clocks/escalations, auto-close, AI triage retries, webhook deliveries, retention.
// Same CRON_SECRET bearer pattern as the other cron routes; scheduled every 5 minutes in vercel.json.
import { NextResponse } from "next/server";
import { runSupportWorker } from "../../../../lib/support/runner.js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  try { return NextResponse.json({ success: true, ...(await runSupportWorker()) }); }
  catch (err) { console.error("cron/support failed:", err); return NextResponse.json({ success: false, error: "The support pass failed." }, { status: 500 }); }
}
