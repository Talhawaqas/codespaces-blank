// GET /api/cron/cloud-backup-run
// Modular Enterprise Adoption Features SOW, Feature 3 -- runs every
// enabled backup schedule whose nextRunAt has passed. Same Vercel Cron
// gate convention as every other route under api/cron/* (Authorization:
// Bearer $CRON_SECRET). Bounded per invocation (findDueSchedules's own
// default limit) so one call never attempts an unbounded number of
// orgs' jobs; any schedule not reached this tick is picked up on the
// next one -- runs are individually bounded too (MAX_OBJECTS_PER_RUN in
// cloudBackupScheduler.js), so a large backlog resumes across multiple
// scheduled ticks rather than timing out a single serverless invocation.

import { NextResponse } from "next/server";
import { findDueSchedules, runBackupJob } from "../../../../lib/cloudBackupScheduler.js";

export async function GET(request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const due = await findDueSchedules();
    const results = [];
    for (const schedule of due) {
      const result = await runBackupJob({ orgId: schedule.orgId, scheduleId: schedule._id, actorEmail: "cron:cloud-backup-run" });
      results.push({ scheduleId: schedule._id.toString(), ...(result.error ? { error: result.error } : { status: result.run.status }) });
    }
    return NextResponse.json({ success: true, schedulesRun: results.length, results });
  } catch (err) {
    console.error("cron/cloud-backup-run failed:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
