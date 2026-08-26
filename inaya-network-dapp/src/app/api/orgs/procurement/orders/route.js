// app/api/orgs/procurement/orders/route.js
//
// GET  /api/orgs/procurement/orders?orgId=...&departmentId=...&status=...&supplierId=...
// POST /api/orgs/procurement/orders  { orgId, departmentId, supplierId, sourceRequestId?, items }
//   items: [{ description, sku?, productId?, warehouseId?, quantity, unitPrice? }]
//   -> create at status DRAFT. An item with BOTH productId and
//      warehouseId set is one that receivePurchaseOrder() (see
//      purchase-order-workflow.js) will actually move real inventory
//      for when it's received — an item without them is just a line
//      item for record-keeping (e.g. a service, or a product not yet
//      tracked in Inventory).

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, canAccessDepartment, toObjectId } from "../../../../../lib/orgs.js";
import { getAccessibleScope } from "../../../../../lib/document-permissions.js";
import { PURCHASE_ORDER_STATES } from "../../../../../lib/purchase-order-workflow.js";

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

function validateItems(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) return { error: "At least one line item is required." };
  const items = [];
  for (const raw of rawItems) {
    const description = String(raw?.description || "").trim();
    if (!description) return { error: "Every line item needs a description." };
    const quantity = Number(raw?.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) return { error: `Invalid quantity for "${description}".` };
    const unitPrice = raw?.unitPrice === undefined || raw?.unitPrice === null ? null : Number(raw.unitPrice);
    if (unitPrice !== null && (!Number.isFinite(unitPrice) || unitPrice < 0)) return { error: `Invalid unit price for "${description}".` };
    items.push({
      description, sku: raw?.sku ? String(raw.sku).trim() : null,
      productId: raw?.productId || null, warehouseId: raw?.warehouseId || null,
      quantity, unitPrice, receivedQuantity: 0,
    });
  }
  return { items };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const departmentId = searchParams.get("departmentId");
    const status = searchParams.get("status");
    const supplierId = searchParams.get("supplierId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    let list;
    if (departmentId) {
      if (!canAccessDepartment(auth.membership, departmentId)) {
        return NextResponse.json({ error: "You don't have access to this department." }, { status: 403 });
      }
      const { purchaseOrders } = await getOrgCollections();
      list = await purchaseOrders.find({ orgId: toObjectId(orgId), departmentId: toObjectId(departmentId), deletedAt: null }).sort({ createdAt: -1 }).toArray();
    } else {
      const scope = await getAccessibleScope({ orgId, membership: auth.membership, email: auth.session.email });
      list = scope.visiblePurchaseOrders;
    }

    if (status && PURCHASE_ORDER_STATES.includes(status)) list = list.filter((po) => po.status === status);
    if (supplierId) list = list.filter((po) => po.supplierId.toString() === supplierId);

    return NextResponse.json({ orders: list.map(serializeOrder) });
  } catch (err) {
    console.error("orgs/procurement/orders GET failed:", err);
    return NextResponse.json({ error: "Could not fetch purchase orders." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const { orgId, departmentId, supplierId, sourceRequestId, items: rawItems } = await req.json();
    if (!orgId || !departmentId || !supplierId) return NextResponse.json({ error: "orgId, departmentId, and supplierId are required." }, { status: 400 });

    const { items, error: itemsError } = validateItems(rawItems);
    if (itemsError) return NextResponse.json({ error: itemsError }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!canAccessDepartment(auth.membership, departmentId)) {
      return NextResponse.json({ error: "You don't have access to this department." }, { status: 403 });
    }

    const { departments, suppliers, purchaseRequests, products, warehouses, purchaseOrders } = await getOrgCollections();
    const orgObjectId = toObjectId(orgId);
    const departmentObjectId = toObjectId(departmentId);
    const supplierObjectId = toObjectId(supplierId);

    const department = await departments.findOne({ _id: departmentObjectId, orgId: orgObjectId });
    if (!department) return NextResponse.json({ error: "Department not found." }, { status: 404 });
    const supplier = await suppliers.findOne({ _id: supplierObjectId, orgId: orgObjectId, deletedAt: null });
    if (!supplier) return NextResponse.json({ error: "Supplier not found." }, { status: 404 });

    let sourceRequestObjectId = null;
    if (sourceRequestId) {
      sourceRequestObjectId = toObjectId(sourceRequestId);
      const request = await purchaseRequests.findOne({ _id: sourceRequestObjectId, orgId: orgObjectId, status: "APPROVED" });
      if (!request) return NextResponse.json({ error: "Source purchase request not found or not APPROVED." }, { status: 404 });
    }

    for (const item of items) {
      if (item.productId) {
        const product = await products.findOne({ _id: toObjectId(item.productId), orgId: orgObjectId, deletedAt: null });
        if (!product) return NextResponse.json({ error: `Product not found for line item "${item.description}".` }, { status: 404 });
        item.productId = product._id;
      }
      if (item.warehouseId) {
        const warehouse = await warehouses.findOne({ _id: toObjectId(item.warehouseId), orgId: orgObjectId });
        if (!warehouse) return NextResponse.json({ error: `Warehouse not found for line item "${item.description}".` }, { status: 404 });
        item.warehouseId = warehouse._id;
      }
    }

    const now = new Date().toISOString();
    const result = await purchaseOrders.insertOne({
      orgId: orgObjectId, departmentId: departmentObjectId, supplierId: supplierObjectId, sourceRequestId: sourceRequestObjectId,
      items, status: "DRAFT", createdByEmail: auth.session.email, createdAt: now, updatedAt: now, deletedAt: null,
    });

    return NextResponse.json(serializeOrder({
      _id: result.insertedId, orgId: orgObjectId, departmentId: departmentObjectId, supplierId: supplierObjectId,
      sourceRequestId: sourceRequestObjectId, items, status: "DRAFT",
      createdByEmail: auth.session.email, createdAt: now, updatedAt: now,
    }));
  } catch (err) {
    console.error("orgs/procurement/orders POST failed:", err);
    return NextResponse.json({ error: "Could not create the purchase order." }, { status: 500 });
  }
}
