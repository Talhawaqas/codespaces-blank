// app/api/orgs/health/billing/route.js
// GET  ?orgId=&patientId= -> list invoices for a patient
// POST { orgId, patientId, lineItems, ... } -> create a patient invoice

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { getAccessibleScope } from "../../../../../lib/document-permissions.js";
import { createPatientInvoice, listInvoicesForPatient } from "../../../../../lib/health-billing.js";

function serialize(i) {
  return { id: i._id.toString(), invoiceNumber: i.invoiceNumber, status: i.status, subtotal: i.subtotal, total: i.total, currency: i.currency, dueDate: i.dueDate };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const patientId = searchParams.get("patientId");
    if (!orgId || !patientId) return NextResponse.json({ error: "orgId and patientId are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const scope = await getAccessibleScope({ orgId, membership: auth.membership, email: auth.session.email });
    if (!scope.visiblePatients.some((p) => p._id.toString() === patientId)) {
      return NextResponse.json({ error: "Patient not found." }, { status: 404 });
    }
    const invoices = await listInvoicesForPatient(orgId, patientId);
    return NextResponse.json({ invoices: invoices.map(serialize) });
  } catch (err) {
    console.error("orgs/health/billing GET failed:", err);
    return NextResponse.json({ error: "Could not fetch invoices." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    if (!body.orgId || !body.patientId || !body.lineItems?.length) return NextResponse.json({ error: "orgId, patientId, and at least one line item are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, body.orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await createPatientInvoice({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ invoice: serialize(result.invoice) });
  } catch (err) {
    console.error("orgs/health/billing POST failed:", err);
    return NextResponse.json({ error: "Could not create invoice." }, { status: 500 });
  }
}
