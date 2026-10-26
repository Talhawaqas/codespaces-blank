// app/api/orgs/inventory/lots/route.js
//
// GET /api/orgs/inventory/lots?orgId=...&expiringWithinDays=30
//   -> batches still in stock that expire within N days (or already have),
//      soonest first, across every product the member can see.
// GET /api/orgs/inventory/lots?orgId=...&lotNumber=...
//   -> traceability for one batch: where it is now, and every movement that
//      touched it (received, issued, transferred, adjusted), newest first,
//      with the customer and order number for batches dispatched on a sales order.

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, toObjectId } from "../../../../../lib/orgs.js";
import { getAccessibleScope } from "../../../../../lib/document-permissions.js";
import { normalizeLotNumber, daysUntilExpiry, fefoSort } from "../../../../../lib/inventory-lots.js";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    const lotNumber = normalizeLotNumber(searchParams.get("lotNumber"));
    const days = Math.min(Math.max(parseInt(searchParams.get("expiringWithinDays") || "30", 10) || 30, 0), 3650);

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const scope = await getAccessibleScope({ orgId, membership: auth.membership, email: auth.session.email });
    const productIds = scope.visibleProducts.map((p) => p._id);
    if (productIds.length === 0) return NextResponse.json({ lots: [], movements: [] });
    const productById = new Map(scope.visibleProducts.map((p) => [p._id.toString(), p]));

    const { stockLots, stockMovements, warehouses, salesOrders, crmContacts } = await getOrgCollections();
    const orgObjectId = toObjectId(orgId);
    const warehouseNameById = new Map((await warehouses.find({ orgId: orgObjectId }).toArray()).map((w) => [w._id.toString(), w.name]));
    const lotView = (l) => {
      const p = productById.get(l.productId.toString());
      return {
        lotNumber: l.lotNumber, expiryDate: l.expiryDate || null, daysToExpiry: daysUntilExpiry(l.expiryDate), quantity: l.quantity,
        productId: l.productId.toString(), productName: p?.name || "Unknown", sku: p?.sku || "", unit: p?.unit || "each",
        warehouseId: l.warehouseId.toString(), warehouseName: warehouseNameById.get(l.warehouseId.toString()) || "Unknown",
      };
    };

    if (lotNumber) {
      const [lots, movements] = await Promise.all([
        stockLots.find({ orgId: orgObjectId, productId: { $in: productIds }, lotNumber }).toArray(),
        stockMovements.find({ orgId: orgObjectId, productId: { $in: productIds }, "lots.lotNumber": lotNumber }).sort({ createdAt: -1 }).limit(200).toArray(),
      ]);
      const orderIds = [...new Set(movements.filter((m) => m.relatedSalesOrderId).map((m) => m.relatedSalesOrderId.toString()))].map(toObjectId);
      const orders = orderIds.length ? await salesOrders.find({ orgId: orgObjectId, _id: { $in: orderIds } }, { projection: { orderNumber: 1, contactId: 1 } }).toArray() : [];
      const contacts = orders.length ? await crmContacts.find({ orgId: orgObjectId, _id: { $in: orders.map((o) => o.contactId) } }, { projection: { name: 1, company: 1 } }).toArray() : [];
      const customerById = new Map(contacts.map((c) => [c._id.toString(), c.company || c.name]));
      const orderById = new Map(orders.map((o) => [o._id.toString(), { orderNumber: o.orderNumber, customerName: customerById.get(o.contactId.toString()) || null }]));
      return NextResponse.json({
        lotNumber,
        lots: lots.map(lotView),
        movements: movements.map((m) => ({
          productName: productById.get(m.productId.toString())?.name || "Unknown",
          warehouseName: warehouseNameById.get(m.warehouseId.toString()) || "Unknown",
          type: m.type, quantity: (m.delta < 0 ? -1 : 1) * (m.lots.find((l) => l.lotNumber === lotNumber)?.quantity || 0),
          relatedPurchaseOrderId: m.relatedPurchaseOrderId ? m.relatedPurchaseOrderId.toString() : null,
          ...(m.relatedSalesOrderId ? orderById.get(m.relatedSalesOrderId.toString()) || {} : {}),
          note: m.note, actorEmail: m.actorEmail, createdAt: m.createdAt,
        })),
      });
    }

    const cutoff = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
    const lots = await stockLots.find({ orgId: orgObjectId, productId: { $in: productIds }, quantity: { $gt: 0 }, expiryDate: { $ne: null, $lte: cutoff } }).toArray();
    return NextResponse.json({ expiringWithinDays: days, lots: fefoSort(lots).map(lotView) });
  } catch (err) {
    console.error("orgs/inventory/lots GET failed:", err);
    return NextResponse.json({ error: "Could not load batches." }, { status: 500 });
  }
}
