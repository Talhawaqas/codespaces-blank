// app/api/orgs/finance/invoices/[invoiceId]/activity/route.js
//
// GET /api/orgs/finance/invoices/:invoiceId/activity?orgId=...

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, canAccessDepartment, canAccessFinance, toObjectId } from "../../../../../../../lib/orgs.js";
import { listOrgActivityForRecord } from "../../../../../../../lib/org-activity-log.js";

export async function GET(req, { params }) {
  try {
    const { invoiceId } = params;
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!canAccessFinance(auth.membership)) return NextResponse.json({ error: "You don't have finance access." }, { status: 403 });

    const { invoices } = await getOrgCollections();
    const invoice = await invoices.findOne({ _id: toObjectId(invoiceId), orgId: toObjectId(orgId) });
    if (!invoice) return NextResponse.json({ error: "Invoice not found." }, { status: 404 });
    if (!canAccessDepartment(auth.membership, invoice.departmentId)) return NextResponse.json({ error: "Invoice not found." }, { status: 404 });

    const events = await listOrgActivityForRecord({ orgId, recordType: "INVOICE", recordId: invoiceId });
    return NextResponse.json({
      activity: events.map((e) => ({ eventId: e.eventId, actorEmail: e.actorEmail, action: e.action, previousState: e.previousState, newState: e.newState, metadata: e.metadata || {}, timestamp: e.timestamp })),
    });
  } catch (err) {
    console.error("orgs/finance/invoices/[invoiceId]/activity failed:", err);
    return NextResponse.json({ error: "Could not fetch invoice activity." }, { status: 500 });
  }
}
