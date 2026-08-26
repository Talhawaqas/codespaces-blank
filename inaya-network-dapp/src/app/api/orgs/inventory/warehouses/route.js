// app/api/orgs/inventory/warehouses/route.js
//
// GET  /api/orgs/inventory/warehouses?orgId=...&departmentId=...
// POST /api/orgs/inventory/warehouses  { orgId, departmentId, name, location? }
//
// No workflow, no soft-delete in this pass (a warehouse with real stock
// levels/movements attached shouldn't just vanish — a real deactivation
// story is a follow-up, not blocking Phase 4's core scope).

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, canAccessDepartment, toObjectId } from "../../../../../lib/orgs.js";
import { getAccessibleScope } from "../../../../../lib/document-permissions.js";

function serializeWarehouse(w) {
  return {
    id: w._id.toString(), orgId: w.orgId.toString(), departmentId: w.departmentId.toString(),
    name: w.name, location: w.location || null, createdByEmail: w.createdByEmail, createdAt: w.createdAt,
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
      const { warehouses } = await getOrgCollections();
      list = await warehouses.find({ orgId: toObjectId(orgId), departmentId: toObjectId(departmentId) }).sort({ name: 1 }).toArray();
    } else {
      const scope = await getAccessibleScope({ orgId, membership: auth.membership, email: auth.session.email });
      list = scope.visibleWarehouses;
    }

    return NextResponse.json({ warehouses: list.map(serializeWarehouse) });
  } catch (err) {
    console.error("orgs/inventory/warehouses GET failed:", err);
    return NextResponse.json({ error: "Could not fetch warehouses." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const { orgId, departmentId, name: rawName, location } = await req.json();
    const name = String(rawName || "").trim();
    if (!orgId || !departmentId) return NextResponse.json({ error: "orgId and departmentId are required." }, { status: 400 });
    if (!name) return NextResponse.json({ error: "Warehouse name is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!canAccessDepartment(auth.membership, departmentId)) {
      return NextResponse.json({ error: "You don't have access to this department." }, { status: 403 });
    }

    const { departments, warehouses } = await getOrgCollections();
    const orgObjectId = toObjectId(orgId);
    const departmentObjectId = toObjectId(departmentId);
    const department = await departments.findOne({ _id: departmentObjectId, orgId: orgObjectId });
    if (!department) return NextResponse.json({ error: "Department not found." }, { status: 404 });

    const now = new Date().toISOString();
    const result = await warehouses.insertOne({
      orgId: orgObjectId, departmentId: departmentObjectId, name, location: location ? String(location).trim() : null,
      createdByEmail: auth.session.email, createdAt: now,
    });

    return NextResponse.json(serializeWarehouse({ _id: result.insertedId, orgId: orgObjectId, departmentId: departmentObjectId, name, location, createdByEmail: auth.session.email, createdAt: now }));
  } catch (err) {
    console.error("orgs/inventory/warehouses POST failed:", err);
    return NextResponse.json({ error: "Could not create the warehouse." }, { status: 500 });
  }
}
