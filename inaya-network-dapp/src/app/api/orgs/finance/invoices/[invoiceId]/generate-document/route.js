// app/api/orgs/finance/invoices/[invoiceId]/generate-document/route.js
// POST { orgId } -> generates, fingerprints, and stores a real invoice PDF (finance-manager-gated)
// GET  ?orgId= -> lists every generated document version for this invoice

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { generateInvoiceDocument, listGeneratedDocuments } from "../../../../../../../lib/documentAutomation/generate.js";

export async function POST(req, { params }) {
  try {
    const { invoiceId } = await params;
    const body = await req.json().catch(() => ({}));
    const { orgId } = body;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await generateInvoiceDocument({ orgId, invoiceId, membership: auth.membership, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    console.error("finance/invoices/[invoiceId]/generate-document POST failed:", err);
    return NextResponse.json({ error: "Could not generate the invoice document." }, { status: 500 });
  }
}

export async function GET(req, { params }) {
  try {
    const { invoiceId } = await params;
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await listGeneratedDocuments({ orgId, sourceRecordType: "INVOICE", sourceRecordId: invoiceId, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("finance/invoices/[invoiceId]/generate-document GET failed:", err);
    return NextResponse.json({ error: "Could not list generated documents." }, { status: 500 });
  }
}
