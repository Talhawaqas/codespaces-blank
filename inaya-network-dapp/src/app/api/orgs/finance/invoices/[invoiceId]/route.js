// app/api/orgs/finance/invoices/[invoiceId]/route.js
//
// GET single invoice; PATCH field edits (only while DRAFT — once sent,
// fields are frozen); DELETE soft-deletes (only while DRAFT).

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, canAccessDepartment, canAccessFinance, toObjectId } from "../../../../../../lib/orgs.js";

function computeTotal(lineItems) {
  return lineItems.reduce((sum, item) => sum + Number(item.quantity) * Number(item.unitPrice), 0);
}

function serializeInvoice(inv) {
  return {
    id: inv._id.toString(), orgId: inv.orgId.toString(), departmentId: inv.departmentId.toString(),
    contactId: inv.contactId.toString(), invoiceNumber: inv.invoiceNumber, issueDate: inv.issueDate, dueDate: inv.dueDate,
    lineItems: inv.lineItems, subtotal: inv.subtotal, total: inv.total, currency: inv.currency, status: inv.status,
    notes: inv.notes || null, createdByEmail: inv.createdByEmail, createdAt: inv.createdAt, updatedAt: inv.updatedAt,
  };
}

async function loadAuthorized(req, orgId, invoiceId) {
  await ensureOrgIndexes();
  const auth = await requireMembership(req, orgId);
  if (auth.error) return { error: auth.error, status: auth.status };
  if (!canAccessFinance(auth.membership)) return { error: "You don't have finance access.", status: 403 };

  const { invoices } = await getOrgCollections();
  const invoice = await invoices.findOne({ _id: toObjectId(invoiceId), orgId: toObjectId(orgId), deletedAt: null });
  if (!invoice) return { error: "Invoice not found.", status: 404 };
  if (!canAccessDepartment(auth.membership, invoice.departmentId)) return { error: "Invoice not found.", status: 404 };

  return { auth, invoice, invoices };
}

export async function GET(req, { params }) {
  try {
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    const result = await loadAuthorized(req, orgId, params.invoiceId);
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(serializeInvoice(result.invoice));
  } catch (err) {
    console.error("orgs/finance/invoices/[invoiceId] GET failed:", err);
    return NextResponse.json({ error: "Could not fetch the invoice." }, { status: 500 });
  }
}

export async function PATCH(req, { params }) {
  try {
    const { orgId, dueDate, lineItems: rawItems, notes } = await req.json();
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    const result = await loadAuthorized(req, orgId, params.invoiceId);
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    const { invoices, invoice } = result;
    if (invoice.status !== "DRAFT") return NextResponse.json({ error: "Only a DRAFT invoice can be edited." }, { status: 409 });

    const updateFields = { updatedAt: new Date().toISOString() };
    if (dueDate !== undefined) updateFields.dueDate = dueDate;
    if (notes !== undefined) updateFields.notes = notes ? String(notes).trim() : null;
    if (rawItems !== undefined) {
      if (!Array.isArray(rawItems) || rawItems.length === 0) return NextResponse.json({ error: "At least one line item is required." }, { status: 400 });
      const total = computeTotal(rawItems);
      updateFields.lineItems = rawItems;
      updateFields.subtotal = total;
      updateFields.total = total;
    }

    await invoices.updateOne({ _id: invoice._id }, { $set: updateFields });
    const updated = await invoices.findOne({ _id: invoice._id });
    return NextResponse.json(serializeInvoice(updated));
  } catch (err) {
    console.error("orgs/finance/invoices/[invoiceId] PATCH failed:", err);
    return NextResponse.json({ error: "Could not update the invoice." }, { status: 500 });
  }
}

export async function DELETE(req, { params }) {
  try {
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    const result = await loadAuthorized(req, orgId, params.invoiceId);
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    if (result.invoice.status !== "DRAFT") return NextResponse.json({ error: "Only a DRAFT invoice can be deleted — cancel it instead once sent." }, { status: 409 });
    await result.invoices.updateOne({ _id: result.invoice._id }, { $set: { deletedAt: new Date().toISOString() } });
    return NextResponse.json({ deleted: true });
  } catch (err) {
    console.error("orgs/finance/invoices/[invoiceId] DELETE failed:", err);
    return NextResponse.json({ error: "Could not delete the invoice." }, { status: 500 });
  }
}
