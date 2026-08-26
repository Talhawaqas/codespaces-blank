// app/api/orgs/procurement/orders/[orderId]/route.js
//
// GET single PO; DELETE soft-deletes (only while DRAFT — see below). No
// PATCH: a PO's items are fixed once created in this pass (editing line
// items after DRAFT would need to interact with receivedQuantity/status
// in ways the SOW doesn't call for yet) — cancel and recreate instead.

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, canAccessDepartment, toObjectId } from "../../../../../../lib/orgs.js";

function serializeOrder(po) {
  return {
    id: po._id.toString(), orgId: po.orgId.toString(), departmentId: po.departmentId.toString(),
    supplierId: po.supplierId.toString(), sourceRequestId: po.sourceRequestId ? po.sourceRequestId.toString() : null,
    items: po.items.map((item) => ({
      description: item.description, sku: item.sku || null,
      productId: item.productId ? item.productId.toString() : null,
      warehouseId: item.warehouseId ? item.warehouseId.toString() : null,
      quantity: item.quantity, unitPrice: item.unitPrice ?? null, receivedQuantity: item.receivedQuantity || 0,
    })),
    status: po.status, createdByEmail: po.createdByEmail, createdAt: po.createdAt, updatedAt: po.updatedAt,
  };
}

export async function GET(req, { params }) {
  try {
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { purchaseOrders } = await getOrgCollections();
    const po = await purchaseOrders.findOne({ _id: toObjectId(params.orderId), orgId: toObjectId(orgId), deletedAt: null });
    if (!po) return NextResponse.json({ error: "Purchase order not found." }, { status: 404 });
    if (!canAccessDepartment(auth.membership, po.departmentId)) return NextResponse.json({ error: "Purchase order not found." }, { status: 404 });

    return NextResponse.json(serializeOrder(po));
  } catch (err) {
    console.error("orgs/procurement/orders/[orderId] GET failed:", err);
    return NextResponse.json({ error: "Could not fetch the purchase order." }, { status: 500 });
  }
}

export async function DELETE(req, { params }) {
  try {
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { purchaseOrders } = await getOrgCollections();
    const po = await purchaseOrders.findOne({ _id: toObjectId(params.orderId), orgId: toObjectId(orgId), deletedAt: null });
    if (!po) return NextResponse.json({ error: "Purchase order not found." }, { status: 404 });
    if (!canAccessDepartment(auth.membership, po.departmentId)) return NextResponse.json({ error: "Purchase order not found." }, { status: 404 });
    if (po.status !== "DRAFT") {
      return NextResponse.json({ error: "Only a DRAFT purchase order can be deleted — cancel it instead once it's been submitted." }, { status: 409 });
    }

    await purchaseOrders.updateOne({ _id: po._id }, { $set: { deletedAt: new Date().toISOString() } });
    return NextResponse.json({ deleted: true });
  } catch (err) {
    console.error("orgs/procurement/orders/[orderId] DELETE failed:", err);
    return NextResponse.json({ error: "Could not delete the purchase order." }, { status: 500 });
  }
}
