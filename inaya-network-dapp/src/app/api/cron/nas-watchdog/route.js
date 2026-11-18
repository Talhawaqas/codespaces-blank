// app/api/cron/nas-watchdog/route.js
//
// GET /api/cron/nas-watchdog -- hourly, same CRON_SECRET bearer check as the other cron routes.
//
// Unlike /api/cron/nas (which must run next to the appliance and is deliberately NOT a Vercel cron), this is a
// database-only check that runs hosted: it notices when the on-host NAS worker has stopped, i.e. enabled snapshot or
// backup policies are overdue, and tells the company's Owners/Admins once per day per appliance
// (src/lib/nas/watchdog.js).
import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cronAuth";
import { checkStaleNasSchedules } from "../../../../lib/nas/watchdog.js";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request) {
  if (!isAuthorizedCron(request.headers.get("authorization"))) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    const { alerts, ...summary } = await checkStaleNasSchedules();
    return NextResponse.json({ success: true, ...summary });
  } catch (err) {
    console.error("cron/nas-watchdog failed:", err);
    return NextResponse.json({ success: false, error: "NAS watchdog failed." }, { status: 500 });
  }
}
