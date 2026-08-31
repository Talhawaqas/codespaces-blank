// app/api/cron/execute-approved-ai-actions/route.js
//
// GET /api/cron/execute-approved-ai-actions — hourly, same CRON_SECRET
// bearer-token pattern as /api/cron/invoices-mark-overdue. Finds every
// APPROVED AI action request across every org whose 36h unlockAt has
// passed and executes the real transitionX() for it — see
// ai-action-requests.js's executeApprovedAiActions() for the atomic
// claim + execute + EXECUTED/EXPIRED bookkeeping.

import { NextResponse } from "next/server";
import { executeApprovedAiActions } from "../../../../lib/ai-action-requests.js";

export async function GET(request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await executeApprovedAiActions();
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    console.error("cron/execute-approved-ai-actions failed:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
