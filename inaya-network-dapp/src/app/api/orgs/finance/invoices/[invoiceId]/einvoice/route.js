// app/api/orgs/finance/invoices/[invoiceId]/einvoice/route.js
//
// GET /api/orgs/finance/invoices/:invoiceId/einvoice?orgId=...[&check=1]
//   -> a UBL 2.1 / Peppol BIS Billing 3.0 XML file (lib/einvoice/ubl.js).
//      422 with { problems: [...] } when required details are missing.
//      check=1 returns { ready, problems } as JSON instead of the file.
// Same access rule as the invoice PDF: finance access + the invoice's department.
// This produces the file only; sending it over the Peppol network needs a
// certified access point and is not done here.

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, canAccessDepartment, canAccessFinance, toObjectId } from "../../../../../../../lib/orgs.js";
import { getDocumentSettings } from "../../../../../../../lib/documentAutomation/settings.js";
import { buildUblInvoice, partiesFrom } from "../../../../../../../lib/einvoice/ubl.js";

export async function GET(req, { params }) {
  try {
    const { invoiceId } = await params;
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!canAccessFinance(auth.membership)) return NextResponse.json({ error: "You don't have finance access." }, { status: 403 });

    const { invoices, orgs, crmContacts } = await getOrgCollections();
    const orgObjectId = toObjectId(orgId);
    let invoice = null;
    try { invoice = await invoices.findOne({ _id: toObjectId(invoiceId), orgId: orgObjectId, deletedAt: null }); } catch { invoice = null; }
    if (!invoice || !canAccessDepartment(auth.membership, invoice.departmentId)) return NextResponse.json({ error: "Invoice not found." }, { status: 404 });

    const [org, contact, settings] = await Promise.all([
      orgs.findOne({ _id: orgObjectId }),
      invoice.contactId ? crmContacts.findOne({ _id: invoice.contactId, orgId: orgObjectId }) : null,
      getDocumentSettings(orgId),
    ]);
    const parties = partiesFrom({ org, billingProfile: settings?.billingProfile || {}, contact: contact || {} });
    const result = buildUblInvoice(invoice, { ...parties, orgDefaultTaxPercent: settings?.billingProfile?.defaultTaxPercent || 0 });

    if (searchParams.get("check")) return NextResponse.json({ ready: !result.errors, problems: result.errors || [] });
    if (result.errors) return NextResponse.json({ error: "This invoice can't be exported as an e-invoice yet.", problems: result.errors }, { status: 422 });
    const filename = `${String(invoice.invoiceNumber).replace(/[^A-Za-z0-9._-]/g, "_")}-ubl.xml`;
    return new NextResponse(result.xml, { headers: { "Content-Type": "application/xml; charset=utf-8", "Content-Disposition": `attachment; filename="${filename}"` } });
  } catch (err) {
    console.error("orgs/finance/invoices/[invoiceId]/einvoice GET failed:", err);
    return NextResponse.json({ error: "Could not build the e-invoice." }, { status: 500 });
  }
}
