// app/api/orgs/procurement/orders/[orderId]/route.js
//
// GET single PO; DELETE soft-deletes (only while DRAFT — see below).
// PATCH edits the optional delivery/tax/shipping fields only (line items
// have their own DRAFT-only items/ route). taxRate and shippingCost change
// the money total an approver signs off on, so they're DRAFT-only like line
// items; expectedDeliveryDate is logistics and stays editable until the PO
// is received, closed, or cancelled.

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, canAccessDepartment, toObjectId } from "../../../../../../lib/orgs.js";
import { logOrgActivity } from "../../../../../../lib/org-activity-log.js";
import { computePoTotals, validatePoExtras } from "../../../../../../lib/purchase-order-totals.js";

const DELIVERY_DATE_LOCKED = ["RECEIVED", "REJECTED", "CANCELLED"];

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
    currency: po.currency || "USD",
    expectedDeliveryDate: po.expectedDeliveryDate || null,
    ...computePoTotals(po),
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

export async function PATCH(req, { params }) {
  try {
    let body = {}; try { body = await req.json(); } catch { body = {}; }
    const { orgId, expectedDeliveryDate, taxRate, shippingCost } = body;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    const { fields, error } = validatePoExtras({ expectedDeliveryDate, taxRate, shippingCost });
    if (error) return NextResponse.json({ error }, { status: 400 });
    if (!Object.keys(fields).length) return NextResponse.json({ error: "Nothing to update." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { purchaseOrders } = await getOrgCollections();
    const po = await purchaseOrders.findOne({ _id: toObjectId(params.orderId), orgId: toObjectId(orgId), deletedAt: null });
    if (!po || !canAccessDepartment(auth.membership, po.departmentId)) return NextResponse.json({ error: "Purchase order not found." }, { status: 404 });

    const changesMoney = "taxRate" in fields || "shippingCost" in fields;
    if (changesMoney && po.status !== "DRAFT") {
      return NextResponse.json({ error: `Tax and shipping can only be changed while the purchase order is DRAFT (it's ${po.status}), because they change the total that was approved.` }, { status: 409 });
    }
    if ("expectedDeliveryDate" in fields && DELIVERY_DATE_LOCKED.includes(po.status)) {
      return NextResponse.json({ error: `The expected delivery date can't be changed once the purchase order is ${po.status}.` }, { status: 409 });
    }

    // The status in the filter means a concurrent transition (e.g. DRAFT ->
    // PENDING_APPROVAL) between the read above and this write makes this a
    // clean 409 rather than a money change slipping past approval.
    const updated = await purchaseOrders.findOneAndUpdate(
      { _id: po._id, status: po.status },
      { $set: { ...fields, updatedAt: new Date().toISOString() } },
      { returnDocument: "after" }
    );
    if (!updated) return NextResponse.json({ error: "This purchase order changed since it was loaded — reload and try again." }, { status: 409 });

    await logOrgActivity({
      orgId: po.orgId, recordType: "PURCHASE_ORDER", recordId: po._id, actorEmail: auth.session.email,
      action: "PO_DETAILS_UPDATED", previousState: null, newState: null, metadata: { fields: Object.keys(fields) },
    });
    return NextResponse.json(serializeOrder(updated));
  } catch (err) {
    console.error("orgs/procurement/orders/[orderId] PATCH failed:", err);
    return NextResponse.json({ error: "Could not update the purchase order." }, { status: 500 });
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
