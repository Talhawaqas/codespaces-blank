// app/api/orgs/finance/invoices/route.js
//
// GET  /api/orgs/finance/invoices?orgId=...&departmentId=...&contactId=...&status=...
// POST /api/orgs/finance/invoices  { orgId, departmentId, contactId, invoiceNumber?, issueDate?, dueDate, lineItems, notes? }
//   -> create at status DRAFT. contactId FKs to the existing crm_contacts —
//      this is the "CRM -> Customer -> Invoice" integration the SOW calls
//      out explicitly, no duplicate customer concept.

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, canAccessDepartment, canAccessFinance, toObjectId } from "../../../../../lib/orgs.js";
import { getAccessibleScope } from "../../../../../lib/document-permissions.js";
import { INVOICE_STATES } from "../../../../../lib/invoice-workflow.js";

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

function validateLineItems(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return { error: "At least one line item is required." };
  const lineItems = [];
  for (const item of raw) {
    const description = String(item?.description || "").trim();
    const quantity = Number(item?.quantity);
    const unitPrice = Number(item?.unitPrice);
    if (!description) return { error: "Every line item needs a description." };
    if (!Number.isFinite(quantity) || quantity <= 0) return { error: `Invalid quantity for "${description}".` };
    if (!Number.isFinite(unitPrice) || unitPrice < 0) return { error: `Invalid unit price for "${description}".` };
    lineItems.push({ description, quantity, unitPrice });
  }
  return { lineItems };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const departmentId = searchParams.get("departmentId");
    const contactId = searchParams.get("contactId");
    const status = searchParams.get("status");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!canAccessFinance(auth.membership)) return NextResponse.json({ error: "You don't have finance access." }, { status: 403 });

    let list;
    if (departmentId) {
      if (!canAccessDepartment(auth.membership, departmentId)) {
        return NextResponse.json({ error: "You don't have access to this department." }, { status: 403 });
      }
      const { invoices } = await getOrgCollections();
      const query = { orgId: toObjectId(orgId), departmentId: toObjectId(departmentId), deletedAt: null };
      if (contactId) query.contactId = toObjectId(contactId);
      list = await invoices.find(query).sort({ createdAt: -1 }).toArray();
    } else {
      const scope = await getAccessibleScope({ orgId, membership: auth.membership, email: auth.session.email });
      list = scope.visibleInvoices;
      if (contactId) list = list.filter((i) => i.contactId.toString() === contactId);
    }
    if (status && INVOICE_STATES.includes(status)) list = list.filter((i) => i.status === status);

    return NextResponse.json({ invoices: list.map(serializeInvoice) });
  } catch (err) {
    console.error("orgs/finance/invoices GET failed:", err);
    return NextResponse.json({ error: "Could not fetch invoices." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const { orgId, departmentId, contactId, invoiceNumber, issueDate, dueDate, lineItems: rawItems, notes } = await req.json();
    if (!orgId || !departmentId || !contactId || !dueDate) {
      return NextResponse.json({ error: "orgId, departmentId, contactId, and dueDate are required." }, { status: 400 });
    }
    const { lineItems, error: itemsError } = validateLineItems(rawItems);
    if (itemsError) return NextResponse.json({ error: itemsError }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!canAccessDepartment(auth.membership, departmentId) || !canAccessFinance(auth.membership)) {
      return NextResponse.json({ error: "You don't have permission to do that." }, { status: 403 });
    }

    const { departments, crmContacts, invoices } = await getOrgCollections();
    const orgObjectId = toObjectId(orgId);
    const departmentObjectId = toObjectId(departmentId);
    const contactObjectId = toObjectId(contactId);

    const department = await departments.findOne({ _id: departmentObjectId, orgId: orgObjectId });
    if (!department) return NextResponse.json({ error: "Department not found." }, { status: 404 });
    const contact = await crmContacts.findOne({ _id: contactObjectId, orgId: orgObjectId, deletedAt: null });
    if (!contact) return NextResponse.json({ error: "Contact not found." }, { status: 404 });

    const total = computeTotal(lineItems);
    const now = new Date().toISOString();
    const result = await invoices.insertOne({
      orgId: orgObjectId, departmentId: departmentObjectId, contactId: contactObjectId,
      invoiceNumber: invoiceNumber ? String(invoiceNumber).trim() : `INV-${Date.now().toString(36).toUpperCase()}`,
      issueDate: issueDate || now, dueDate, lineItems, subtotal: total, total, currency: "USD",
      status: "DRAFT", notes: notes ? String(notes).trim() : null,
      createdByEmail: auth.session.email, createdAt: now, updatedAt: now, deletedAt: null,
    });

    return NextResponse.json(serializeInvoice({
      _id: result.insertedId, orgId: orgObjectId, departmentId: departmentObjectId, contactId: contactObjectId,
      invoiceNumber: invoiceNumber || `INV-${Date.now().toString(36).toUpperCase()}`, issueDate: issueDate || now, dueDate,
      lineItems, subtotal: total, total, currency: "USD", status: "DRAFT", notes,
      createdByEmail: auth.session.email, createdAt: now, updatedAt: now,
    }));
  } catch (err) {
    console.error("orgs/finance/invoices POST failed:", err);
    return NextResponse.json({ error: "Could not create the invoice." }, { status: 500 });
  }
}
