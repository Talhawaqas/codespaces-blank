// GET /api/cron/governance-lifecycle -- daily: apply the time-based part of published retention and archival policies (CRON_SECRET bearer). Runs through withJobRun, so it never overlaps itself.
import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cronAuth";
import { runGovernanceLifecycle } from "../../../../lib/governance/lifecycle.js";
import { withJobRun } from "../../../../lib/jobs/run.js";
export const dynamic = "force-dynamic";
export async function GET(request) {
  if (!isAuthorizedCron(request.headers.get("authorization"))) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  try {
    const r = await withJobRun({ name: "governance-lifecycle", staleSeconds: 3600, minIntervalSeconds: 3600 * 12, fn: () => runGovernanceLifecycle() });
    return NextResponse.json({ success: r.status !== "failed", job: r.status, ...(r.result || {}) });
  } catch (err) { console.error("governance-lifecycle failed:", err?.name); return NextResponse.json({ success: false, error: "Job failed." }, { status: 500 }); }
}
