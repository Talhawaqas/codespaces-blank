// app/api/orgs/procurement/suppliers/[supplierId]/route.js
//
// GET single supplier; PATCH field edits including status (ACTIVE/
// INACTIVE); DELETE soft-deletes. Department-access-only, same
// collaborative model as the rest of Procurement/CRM Phase 1-3.

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, canAccessDepartment, toObjectId } from "../../../../../../lib/orgs.js";

const STATUSES = ["ACTIVE", "INACTIVE"];

function serializeSupplier(s) {
  return {
    id: s._id.toString(), orgId: s.orgId.toString(), departmentId: s.departmentId.toString(),
    name: s.name, contactEmail: s.contactEmail || null, phone: s.phone || null, notes: s.notes || null,
    status: s.status, createdByEmail: s.createdByEmail, createdAt: s.createdAt, updatedAt: s.updatedAt,
  };
}

async function loadAuthorized(req, orgId, supplierId) {
  await ensureOrgIndexes();
  const auth = await requireMembership(req, orgId);
  if (auth.error) return { error: auth.error, status: auth.status };

  const { suppliers } = await getOrgCollections();
  const supplier = await suppliers.findOne({ _id: toObjectId(supplierId), orgId: toObjectId(orgId), deletedAt: null });
  if (!supplier) return { error: "Supplier not found.", status: 404 };
  if (!canAccessDepartment(auth.membership, supplier.departmentId)) return { error: "Supplier not found.", status: 404 };

  return { auth, supplier, suppliers };
}

export async function GET(req, { params }) {
  try {
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    const result = await loadAuthorized(req, orgId, params.supplierId);
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(serializeSupplier(result.supplier));
  } catch (err) {
    console.error("orgs/procurement/suppliers/[supplierId] GET failed:", err);
    return NextResponse.json({ error: "Could not fetch the supplier." }, { status: 500 });
  }
}

export async function PATCH(req, { params }) {
  try {
    const { orgId, name, contactEmail, phone, notes, status } = await req.json();
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    const result = await loadAuthorized(req, orgId, params.supplierId);
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    const { suppliers, supplier } = result;

    const updateFields = { updatedAt: new Date().toISOString() };
    if (name !== undefined) {
      const trimmed = String(name).trim();
      if (!trimmed) return NextResponse.json({ error: "Supplier name cannot be empty." }, { status: 400 });
      updateFields.name = trimmed;
    }
    if (contactEmail !== undefined) updateFields.contactEmail = contactEmail ? String(contactEmail).trim().toLowerCase() : null;
    if (phone !== undefined) updateFields.phone = phone ? String(phone).trim() : null;
    if (notes !== undefined) updateFields.notes = notes ? String(notes).trim() : null;
    if (status !== undefined) {
      if (!STATUSES.includes(status)) return NextResponse.json({ error: "Invalid status." }, { status: 400 });
      updateFields.status = status;
    }

    await suppliers.updateOne({ _id: supplier._id }, { $set: updateFields });
    const updated = await suppliers.findOne({ _id: supplier._id });
    return NextResponse.json(serializeSupplier(updated));
  } catch (err) {
    console.error("orgs/procurement/suppliers/[supplierId] PATCH failed:", err);
    return NextResponse.json({ error: "Could not update the supplier." }, { status: 500 });
  }
}

export async function DELETE(req, { params }) {
  try {
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    const result = await loadAuthorized(req, orgId, params.supplierId);
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    await result.suppliers.updateOne({ _id: result.supplier._id }, { $set: { deletedAt: new Date().toISOString() } });
    return NextResponse.json({ deleted: true });
  } catch (err) {
    console.error("orgs/procurement/suppliers/[supplierId] DELETE failed:", err);
    return NextResponse.json({ error: "Could not delete the supplier." }, { status: 500 });
  }
}
