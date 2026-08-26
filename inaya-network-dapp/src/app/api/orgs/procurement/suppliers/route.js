// app/api/orgs/procurement/suppliers/route.js
//
// GET  /api/orgs/procurement/suppliers?orgId=...&departmentId=...
// POST /api/orgs/procurement/suppliers  { orgId, departmentId, name, contactEmail?, phone?, notes? }
//
// Suppliers have no workflow state — just an ACTIVE/INACTIVE status a
// manager can toggle (PATCH on the detail route), department-access-only
// like every other collaborative Procurement/CRM record in this phase.

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, canAccessDepartment, toObjectId } from "../../../../../lib/orgs.js";
import { getAccessibleScope } from "../../../../../lib/document-permissions.js";

function serializeSupplier(s) {
  return {
    id: s._id.toString(), orgId: s.orgId.toString(), departmentId: s.departmentId.toString(),
    name: s.name, contactEmail: s.contactEmail || null, phone: s.phone || null, notes: s.notes || null,
    status: s.status, createdByEmail: s.createdByEmail, createdAt: s.createdAt, updatedAt: s.updatedAt,
  };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const departmentId = searchParams.get("departmentId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    let list;
    if (departmentId) {
      if (!canAccessDepartment(auth.membership, departmentId)) {
        return NextResponse.json({ error: "You don't have access to this department." }, { status: 403 });
      }
      const { suppliers } = await getOrgCollections();
      list = await suppliers.find({ orgId: toObjectId(orgId), departmentId: toObjectId(departmentId), deletedAt: null }).sort({ name: 1 }).toArray();
    } else {
      const scope = await getAccessibleScope({ orgId, membership: auth.membership, email: auth.session.email });
      list = scope.visibleSuppliers;
    }

    return NextResponse.json({ suppliers: list.map(serializeSupplier) });
  } catch (err) {
    console.error("orgs/procurement/suppliers GET failed:", err);
    return NextResponse.json({ error: "Could not fetch suppliers." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const { orgId, departmentId, name: rawName, contactEmail, phone, notes } = await req.json();
    const name = String(rawName || "").trim();
    if (!orgId || !departmentId) return NextResponse.json({ error: "orgId and departmentId are required." }, { status: 400 });
    if (!name) return NextResponse.json({ error: "Supplier name is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!canAccessDepartment(auth.membership, departmentId)) {
      return NextResponse.json({ error: "You don't have access to this department." }, { status: 403 });
    }

    const { departments, suppliers } = await getOrgCollections();
    const orgObjectId = toObjectId(orgId);
    const departmentObjectId = toObjectId(departmentId);
    const department = await departments.findOne({ _id: departmentObjectId, orgId: orgObjectId });
    if (!department) return NextResponse.json({ error: "Department not found." }, { status: 404 });

    const now = new Date().toISOString();
    const result = await suppliers.insertOne({
      orgId: orgObjectId, departmentId: departmentObjectId, name,
      contactEmail: contactEmail ? String(contactEmail).trim().toLowerCase() : null,
      phone: phone ? String(phone).trim() : null,
      notes: notes ? String(notes).trim() : null,
      status: "ACTIVE", createdByEmail: auth.session.email, createdAt: now, updatedAt: now, deletedAt: null,
    });

    return NextResponse.json(serializeSupplier({
      _id: result.insertedId, orgId: orgObjectId, departmentId: departmentObjectId, name,
      contactEmail, phone, notes, status: "ACTIVE", createdByEmail: auth.session.email, createdAt: now, updatedAt: now,
    }));
  } catch (err) {
    console.error("orgs/procurement/suppliers POST failed:", err);
    return NextResponse.json({ error: "Could not create the supplier." }, { status: 500 });
  }
}
