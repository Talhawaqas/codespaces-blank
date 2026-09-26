// app/api/cron/workflows/route.js
//
// GET /api/cron/workflows -- fires due workflow schedules, resumes approvals, drains the execution queue and
// runs retention/health housekeeping. Same CRON_SECRET bearer pattern as the other cron routes. Scheduled every
// 5 minutes in vercel.json (paid plan); scripts/workflow-worker.mjs runs the same pass anywhere else.
import { NextResponse } from "next/server";
import { ensureOrgIndexes } from "../../../../lib/orgs.js";
import { runWorkflowWorker } from "../../../../lib/workflows/runner.js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    await ensureOrgIndexes();
    const r = await runWorkflowWorker({ maxExecutions: 5, maintenance: true });
    return NextResponse.json({ success: true, ...r });
  } catch (err) {
    console.error("cron/workflows failed:", err);
    return NextResponse.json({ success: false, error: "The workflow pass failed." }, { status: 500 });
  }
}
