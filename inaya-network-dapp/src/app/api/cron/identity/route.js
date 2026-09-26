// app/api/cron/identity/route.js
//
// GET /api/cron/identity -- temporary-access expiry, unfinished revocation retries, parked events, bulk jobs, review reminders,
// orphan detection, scheduled directory pulls, outbound event delivery. CRON_SECRET bearer, every 5 minutes (vercel.json).
import { NextResponse } from "next/server";
import { runIdentityWorker } from "../../../../lib/identity/worker.js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  try { return NextResponse.json({ success: true, ...(await runIdentityWorker()) }); }
  catch (err) { console.error("cron/identity failed:", err); return NextResponse.json({ success: false, error: "The identity pass failed." }, { status: 500 }); }
}
