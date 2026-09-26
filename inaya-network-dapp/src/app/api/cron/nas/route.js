// app/api/cron/nas/route.js
//
// GET /api/cron/nas -- one NAS worker pass (schedules -> idempotent jobs ->
// run). Same CRON_SECRET bearer pattern as the other cron routes.
//
// NOT in vercel.json on purpose: the worker must reach the appliance agent, and
// the hosted website cannot reach a NAS on a customer's network. Run this (or
// scripts/nas-worker.mjs) on the host that runs the control plane next to the
// appliance.
import { NextResponse } from "next/server";
import { ensureOrgIndexes } from "../../../../lib/orgs.js";
import { runNasWorker } from "../../../../lib/nas/runner.js";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    await ensureOrgIndexes();
    const result = await runNasWorker({});
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    console.error("cron/nas failed:", err);
    return NextResponse.json({ success: false, error: "NAS worker failed." }, { status: 500 });
  }
}
