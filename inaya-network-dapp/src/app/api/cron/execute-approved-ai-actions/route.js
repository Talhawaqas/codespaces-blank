// app/api/cron/execute-approved-ai-actions/route.js
//
// GET /api/cron/execute-approved-ai-actions — daily, same CRON_SECRET
// bearer-token pattern as /api/cron/invoices-mark-overdue. Daily rather
// than hourly because the Vercel account this deploys to is on the
// Hobby plan, which rejects any cron schedule finer than once/day at
// deploy time — an hourly schedule is what this route originally shipped
// with, but it made the WHOLE deployment fail, not just this route, so
// it was changed to daily. Functionally harmless either way: this only
// adds a few extra hours of latency after a request's 36h unlockAt has
// already passed, it doesn't change correctness. Finds every APPROVED AI
// action request across every org whose unlockAt has passed and executes
// the real transitionX() for it — see ai-action-requests.js's
// executeApprovedAiActions() for the atomic claim + execute +
// EXECUTED/EXPIRED bookkeeping.

import { NextResponse } from "next/server";
import { executeApprovedAiActions, expireStalePendingActions } from "../../../../lib/ai-action-requests.js";

export async function GET(request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Two independent sweeps in one daily run: execute what's due, and
    // expire proposals nobody ever reviewed (Phase 10) — no new cron entry
    // needed for the latter, same schedule is frequent enough for a 7-day
    // expiry window.
    const [executed, expired] = await Promise.all([executeApprovedAiActions(), expireStalePendingActions()]);
    return NextResponse.json({ success: true, ...executed, ...expired });
  } catch (err) {
    console.error("cron/execute-approved-ai-actions failed:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
