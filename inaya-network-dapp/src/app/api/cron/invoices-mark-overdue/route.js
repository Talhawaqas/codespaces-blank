// app/api/cron/invoices-mark-overdue/route.js
//
// GET /api/cron/invoices-mark-overdue — nightly, same CRON_SECRET bearer-
// token pattern as /api/security/cron/checkpoint-reputation and
// /api/cron/rag-reingest. Flips any SENT invoice whose dueDate has passed
// to OVERDUE — see invoice-workflow.js's markOverdueInvoices() header
// comment for why this is cron-driven rather than a computed flag like
// Tasks' overdue detection.

import { NextResponse } from "next/server";
import { markOverdueInvoices } from "../../../../lib/invoice-workflow.js";

export async function GET(request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await markOverdueInvoices();
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    console.error("cron/invoices-mark-overdue failed:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
