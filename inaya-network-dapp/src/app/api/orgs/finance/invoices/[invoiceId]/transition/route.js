// app/api/orgs/finance/invoices/[invoiceId]/transition/route.js
//
// POST /api/orgs/finance/invoices/:invoiceId/transition
// Body: { orgId, action, note? } — action is one of: send, markPaid, cancel
// (NOT "markOverdue" — that's cron-driven, see invoice-workflow.js's
// markOverdueInvoices() and /api/cron/invoices-mark-overdue.)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { transitionInvoice } from "../../../../../../../lib/invoice-workflow.js";

export async function POST(req, { params }) {
  try {
    const { invoiceId } = params;
    const { orgId, action, note } = await req.json();
    if (!orgId || !action) return NextResponse.json({ error: "orgId and action are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await transitionInvoice({ orgId, invoiceId, action, membership: auth.membership, actorEmail: auth.session.email, note });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });

    return NextResponse.json({ status: result.invoice.status, updatedAt: result.invoice.updatedAt });
  } catch (err) {
    console.error("orgs/finance/invoices/[invoiceId]/transition failed:", err);
    return NextResponse.json({ error: "Could not update the invoice's status." }, { status: 500 });
  }
}
