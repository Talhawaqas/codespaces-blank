// app/api/cron/no-plan-reminders/route.js
//
// GET /api/cron/no-plan-reminders — daily, same CRON_SECRET bearer-token
// pattern as /api/cron/invoices-mark-overdue. Emails any org owner stuck
// at the plan-selection gate (created >24h ago, never picked a plan,
// never explicitly continued for free) a real magic link back into
// their workspace, where they can now pick a plan OR continue free on
// Starter-equivalent limits. Sent exactly once per org — see
// orgPlans.js's sendNoPlanReminders() header for the idempotency detail.

import { NextResponse } from "next/server";
import { sendNoPlanReminders } from "../../../../lib/orgPlans.js";

export async function GET(request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await sendNoPlanReminders();
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    console.error("cron/no-plan-reminders failed:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
