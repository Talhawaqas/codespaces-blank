// app/api/cron/document-automation/route.js
//
// GET /api/cron/document-automation -- hourly, same CRON_SECRET bearer-token
// pattern as invoices-mark-overdue / execute-approved-ai-actions. Retries
// recoverable document failures (storage / evidence) idempotently, expires
// stale approvals and lapsed quotations, reconciles invoice PAID/CANCELLED
// into documents, and sends link-expiry notifications. See jobs.js.
import { NextResponse } from "next/server";
import { ensureOrgIndexes } from "../../../../lib/orgs.js";
import { runDocumentAutomationSweep } from "../../../../lib/documentAutomation/jobs.js";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    await ensureOrgIndexes();
    const result = await runDocumentAutomationSweep();
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    console.error("cron/document-automation failed:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
