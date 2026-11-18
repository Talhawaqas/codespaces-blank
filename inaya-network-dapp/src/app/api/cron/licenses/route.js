// app/api/cron/licenses/route.js -- hourly: company license grace periods, reminders, suspension and data exports.
// Same CRON_SECRET bearer check as every other cron; one live run at a time (withJobRun). See src/lib/licensing/job.js.
import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cronAuth";
import { withJobRun } from "../../../../lib/jobs/run.js";
import { runLicenseJob } from "../../../../lib/licensing/job.js";
import { autoSuspendEnabled } from "../../../../lib/licensing/config.js";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request) {
  if (!isAuthorizedCron(request.headers.get("authorization"))) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  const r = await withJobRun({ name: "licenses", retries: 0, fn: async () => runLicenseJob({}) });
  return NextResponse.json({ success: r.status !== "failed", autoSuspend: autoSuspendEnabled(), ...r }, { status: r.status === "failed" ? 500 : 200 });
}
