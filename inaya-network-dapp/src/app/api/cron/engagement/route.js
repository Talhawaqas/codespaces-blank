// app/api/cron/engagement/route.js
//
// GET /api/cron/engagement -- Appointments & Campaigns worker: appointment reminders (email + SMS) and post-meeting
// prompts, calendar-import refresh, scheduled/recurring campaign delivery, follow-up sequence emails.
// Same CRON_SECRET bearer pattern as the other cron routes; scheduled every 5 minutes in vercel.json.
import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cronAuth";
import { withJobRun } from "../../../../lib/jobs/run.js";
import { processDueReminders } from "../../../../lib/engagement/reminders.js";
import { syncDueImports } from "../../../../lib/engagement/feeds.js";
import { processCampaigns } from "../../../../lib/engagement/sender.js";
import { processDueEnrollments } from "../../../../lib/engagement/sequences.js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request) {
  if (!isAuthorizedCron(request.headers.get("authorization"))) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  try {
    const r = await withJobRun({
      name: "engagement", retries: 0,
      fn: async () => {
        const out = {};
        for (const [k, f] of [["reminders", () => processDueReminders()], ["campaigns", () => processCampaigns()], ["sequences", () => processDueEnrollments()], ["calendarImports", () => syncDueImports()]]) {
          try { out[k] = await f(); } catch (e) { console.error(`cron/engagement ${k} failed:`, e?.message); out[k] = { error: String(e?.message || e).slice(0, 200) }; }
        }
        return out;
      },
    });
    return NextResponse.json({ success: r.status !== "failed", ...r });
  } catch (err) {
    console.error("cron/engagement failed:", err);
    return NextResponse.json({ success: false, error: "The engagement pass failed." }, { status: 500 });
  }
}
