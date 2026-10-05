// GET /api/cron/share-expiry -- hourly: notify creators of share links that expire within 48 hours (CRON_SECRET bearer).
import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cronAuth";
import { notifyExpiringShares } from "../../../../lib/notify/jobs.js";
import { withJobRun } from "../../../../lib/jobs/run.js";
export const dynamic = "force-dynamic";
export async function GET(request) {
  if (!isAuthorizedCron(request.headers.get("authorization"))) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  try { const r = await withJobRun({ name: "share-expiry", staleSeconds: 1800, fn: () => notifyExpiringShares() }); return NextResponse.json({ success: r.status !== "failed", job: r.status, ...(r.result || {}) }, { status: r.status === "failed" ? 500 : 200 }); } catch (err) { console.error("cron/share-expiry failed:", err); return NextResponse.json({ success: false, error: "Job failed." }, { status: 500 }); }
}
