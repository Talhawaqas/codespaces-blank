// GET /api/cron/storage-backup-run
// IBM Cloud VPC Storage Gap Expansion SOW -- runs every enabled backup
// policy's due plans. Same Vercel Cron gate convention as every other
// route under api/cron/* (Authorization: Bearer $CRON_SECRET).

import { NextResponse } from "next/server";
import { findDueBackupPlans, runBackupPolicyPlan } from "../../../../lib/storageBackupPolicies.js";

export async function GET(request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const duePlans = await findDueBackupPlans();
    const results = [];
    for (const plan of duePlans) {
      const result = await runBackupPolicyPlan({ orgId: plan.orgId.toString(), planId: plan._id.toString(), actorEmail: "cron:storage-backup-run" });
      results.push({ planId: plan._id.toString(), ...(result.error ? { error: result.error } : { resourcesProcessed: result.resourcesProcessed }) });
    }
    return NextResponse.json({ success: true, plansRun: results.length, results });
  } catch (err) {
    console.error("cron/storage-backup-run failed:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
