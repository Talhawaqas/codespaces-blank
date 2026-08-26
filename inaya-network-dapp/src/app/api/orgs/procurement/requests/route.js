// app/api/orgs/procurement/requests/route.js
//
// GET  /api/orgs/procurement/requests?orgId=...&departmentId=...&status=...
// POST /api/orgs/procurement/requests  { orgId, departmentId, title, description?, supplierId?, estimatedCost? }
//   -> create at status DRAFT. See purchase-request-workflow.js for the
//      approval state machine this feeds into.

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, canAccessDepartment, toObjectId } from "../../../../../lib/orgs.js";
import { getAccessibleScope } from "../../../../../lib/document-permissions.js";
import { PURCHASE_REQUEST_STATES } from "../../../../../lib/purchase-request-workflow.js";

function serializeRequest(r) {
  return {
    id: r._id.toString(), orgId: r.orgId.toString(), departmentId: r.departmentId.toString(),
    supplierId: r.supplierId ? r.supplierId.toString() : null,
    title: r.title, description: r.description || null, estimatedCost: r.estimatedCost ?? null,
    status: r.status, createdByEmail: r.createdByEmail, createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const departmentId = searchParams.get("departmentId");
    const status = searchParams.get("status");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    let list;
    if (departmentId) {
      if (!canAccessDepartment(auth.membership, departmentId)) {
        return NextResponse.json({ error: "You don't have access to this department." }, { status: 403 });
      }
      const { purchaseRequests } = await getOrgCollections();
      list = await purchaseRequests.find({ orgId: toObjectId(orgId), departmentId: toObjectId(departmentId), deletedAt: null }).sort({ createdAt: -1 }).toArray();
    } else {
      const scope = await getAccessibleScope({ orgId, membership: auth.membership, email: auth.session.email });
      list = scope.visiblePurchaseRequests;
    }

    if (status && PURCHASE_REQUEST_STATES.includes(status)) list = list.filter((r) => r.status === status);

    return NextResponse.json({ requests: list.map(serializeRequest) });
  } catch (err) {
    console.error("orgs/procurement/requests GET failed:", err);
    return NextResponse.json({ error: "Could not fetch purchase requests." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const { orgId, departmentId, title: rawTitle, description, supplierId, estimatedCost } = await req.json();
    const title = String(rawTitle || "").trim();
    if (!orgId || !departmentId) return NextResponse.json({ error: "orgId and departmentId are required." }, { status: 400 });
    if (!title) return NextResponse.json({ error: "Request title is required." }, { status: 400 });
    if (estimatedCost !== undefined && estimatedCost !== null && !Number.isFinite(estimatedCost)) {
      return NextResponse.json({ error: "estimatedCost must be a number." }, { status: 400 });
    }

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!canAccessDepartment(auth.membership, departmentId)) {
      return NextResponse.json({ error: "You don't have access to this department." }, { status: 403 });
    }

    const { departments, suppliers, purchaseRequests } = await getOrgCollections();
    const orgObjectId = toObjectId(orgId);
    const departmentObjectId = toObjectId(departmentId);
    const department = await departments.findOne({ _id: departmentObjectId, orgId: orgObjectId });
    if (!department) return NextResponse.json({ error: "Department not found." }, { status: 404 });

    let supplierObjectId = null;
    if (supplierId) {
      supplierObjectId = toObjectId(supplierId);
      const supplier = await suppliers.findOne({ _id: supplierObjectId, orgId: orgObjectId, deletedAt: null });
      if (!supplier) return NextResponse.json({ error: "Supplier not found." }, { status: 404 });
    }

    const now = new Date().toISOString();
    const result = await purchaseRequests.insertOne({
      orgId: orgObjectId, departmentId: departmentObjectId, supplierId: supplierObjectId,
      title, description: description ? String(description).trim() : null, estimatedCost: estimatedCost ?? null,
      status: "DRAFT", createdByEmail: auth.session.email, createdAt: now, updatedAt: now, deletedAt: null,
    });

    return NextResponse.json(serializeRequest({
      _id: result.insertedId, orgId: orgObjectId, departmentId: departmentObjectId, supplierId: supplierObjectId,
      title, description, estimatedCost: estimatedCost ?? null, status: "DRAFT",
      createdByEmail: auth.session.email, createdAt: now, updatedAt: now,
    }));
  } catch (err) {
    console.error("orgs/procurement/requests POST failed:", err);
    return NextResponse.json({ error: "Could not create the purchase request." }, { status: 500 });
  }
}
