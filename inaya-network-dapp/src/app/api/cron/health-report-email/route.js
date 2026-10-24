// app/api/cron/health-report-email/route.js
//
// 09:00 PKT (04:00 UTC, vercel.json): emails today's daily health report,
// plus a fresh database check, to HEALTH_REPORT_EMAIL (src/lib/healthReport.js).

import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cronAuth";
import { sendEmail } from "../../../../lib/email.js";
import { getTodaysHealthReport, liveDatabaseCheck, buildHealthEmail } from "../../../../lib/healthReport.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  if (!isAuthorizedCron(request.headers.get("authorization"))) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  const to = process.env.HEALTH_REPORT_EMAIL;
  if (!to) return NextResponse.json({ success: false, error: "HEALTH_REPORT_EMAIL is not set." }, { status: 500 });

  const live = await liveDatabaseCheck();
  let report = null;
  try {
    report = await getTodaysHealthReport();
  } catch (err) {
    console.error("cron/health-report-email: could not read the report:", err.message);
  }
  const day = new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10);
  const email = buildHealthEmail({ report, live, day });
  const result = await sendEmail({ to, ...email });
  return NextResponse.json({ success: result.sent, reportFound: !!report, databaseOk: live.ok });
}
