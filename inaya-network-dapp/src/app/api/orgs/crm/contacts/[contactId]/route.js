// app/api/orgs/crm/contacts/[contactId]/route.js
//
// GET single contact; PATCH field edits (including converting LEAD ->
// CUSTOMER by setting type) — any member with department access, same
// collaborative model Tasks uses (no creator/manage restriction, since a
// contact is a shared team record, not something one person "owns");
// DELETE soft-deletes.

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, canAccessDepartment, toObjectId } from "../../../../../../lib/orgs.js";

const CONTACT_TYPES = ["LEAD", "CUSTOMER"];

function serializeContact(c) {
  return {
    id: c._id.toString(), orgId: c.orgId.toString(), departmentId: c.departmentId.toString(),
    type: c.type, name: c.name, email: c.email || null, phone: c.phone || null,
    company: c.company || null, notes: c.notes || null,
    createdByEmail: c.createdByEmail, createdAt: c.createdAt, updatedAt: c.updatedAt,
  };
}

async function loadAuthorized(req, orgId, contactId) {
  await ensureOrgIndexes();
  const auth = await requireMembership(req, orgId);
  if (auth.error) return { error: auth.error, status: auth.status };

  const { crmContacts } = await getOrgCollections();
  const contact = await crmContacts.findOne({ _id: toObjectId(contactId), orgId: toObjectId(orgId), deletedAt: null });
  if (!contact) return { error: "Contact not found.", status: 404 };
  if (!canAccessDepartment(auth.membership, contact.departmentId)) return { error: "Contact not found.", status: 404 };

  return { auth, contact, crmContacts };
}

export async function GET(req, { params }) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    const result = await loadAuthorized(req, orgId, params.contactId);
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(serializeContact(result.contact));
  } catch (err) {
    console.error("orgs/crm/contacts/[contactId] GET failed:", err);
    return NextResponse.json({ error: "Could not fetch the contact." }, { status: 500 });
  }
}

export async function PATCH(req, { params }) {
  try {
    const body = await req.json();
    const { orgId, type, name, email, phone, company, notes } = body;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    const result = await loadAuthorized(req, orgId, params.contactId);
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    const { crmContacts, contact } = result;

    const updateFields = { updatedAt: new Date().toISOString() };
    if (type !== undefined) {
      if (!CONTACT_TYPES.includes(type)) return NextResponse.json({ error: "Invalid contact type." }, { status: 400 });
      updateFields.type = type;
    }
    if (name !== undefined) {
      const trimmed = String(name).trim();
      if (!trimmed) return NextResponse.json({ error: "Contact name cannot be empty." }, { status: 400 });
      updateFields.name = trimmed;
    }
    if (email !== undefined) updateFields.email = email ? String(email).trim().toLowerCase() : null;
    if (phone !== undefined) updateFields.phone = phone ? String(phone).trim() : null;
    if (company !== undefined) updateFields.company = company ? String(company).trim() : null;
    if (notes !== undefined) updateFields.notes = notes ? String(notes).trim() : null;

    await crmContacts.updateOne({ _id: contact._id }, { $set: updateFields });
    const updated = await crmContacts.findOne({ _id: contact._id });
    return NextResponse.json(serializeContact(updated));
  } catch (err) {
    console.error("orgs/crm/contacts/[contactId] PATCH failed:", err);
    return NextResponse.json({ error: "Could not update the contact." }, { status: 500 });
  }
}

export async function DELETE(req, { params }) {
  try {
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    const result = await loadAuthorized(req, orgId, params.contactId);
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });

    await result.crmContacts.updateOne({ _id: result.contact._id }, { $set: { deletedAt: new Date().toISOString() } });
    return NextResponse.json({ deleted: true });
  } catch (err) {
    console.error("orgs/crm/contacts/[contactId] DELETE failed:", err);
    return NextResponse.json({ error: "Could not delete the contact." }, { status: 500 });
  }
}
