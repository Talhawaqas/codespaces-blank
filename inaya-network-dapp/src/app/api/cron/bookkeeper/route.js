// GET /api/cron/bookkeeper -- AI Bookkeeper safety-net pass (retry AI-blocked documents, failed bank syncs, settle matches). CRON_SECRET bearer.
import { NextResponse } from "next/server";
import { runBookkeeperWorker } from "../../../../lib/bookkeeper/worker.js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  try { return NextResponse.json({ success: true, ...(await runBookkeeperWorker()) }); }
  catch (err) { console.error("cron/bookkeeper failed:", err); return NextResponse.json({ success: false, error: "The bookkeeping pass failed." }, { status: 500 }); }
}
