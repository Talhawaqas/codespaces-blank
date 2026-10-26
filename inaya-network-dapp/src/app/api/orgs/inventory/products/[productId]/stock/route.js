// app/api/orgs/inventory/products/[productId]/stock/route.js
//
// GET /api/orgs/inventory/products/:productId/stock?orgId=...
// -> per-warehouse stock levels for this product, its batches / lots with
//    quantities and expiry dates (when it tracks them), plus the recent
//    movement history (append-only ledger — this IS the inventory
//    activity history the SOW calls for, no separate log needed).

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, canAccessDepartment, toObjectId } from "../../../../../../../lib/orgs.js";
import { listStockLevelsForProduct } from "../../../../../../../lib/inventory.js";
import { fefoSort, daysUntilExpiry } from "../../../../../../../lib/inventory-lots.js";

export async function GET(req, { params }) {
  try {
    const { productId } = params;
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { products, warehouses, stockMovements, stockLots } = await getOrgCollections();
    const orgObjectId = toObjectId(orgId);
    const productObjectId = toObjectId(productId);
    const product = await products.findOne({ _id: productObjectId, orgId: orgObjectId, deletedAt: null });
    if (!product) return NextResponse.json({ error: "Product not found." }, { status: 404 });
    if (!canAccessDepartment(auth.membership, product.departmentId)) return NextResponse.json({ error: "Product not found." }, { status: 404 });

    const [levels, allWarehouses, movements, lots] = await Promise.all([
      listStockLevelsForProduct(orgId, productObjectId),
      warehouses.find({ orgId: orgObjectId }).toArray(),
      stockMovements.find({ orgId: orgObjectId, productId: productObjectId }).sort({ createdAt: -1 }).limit(50).toArray(),
      stockLots.find({ orgId: orgObjectId, productId: productObjectId, quantity: { $gt: 0 } }).toArray(),
    ]);
    const warehouseNameById = new Map(allWarehouses.map((w) => [w._id.toString(), w.name]));

    return NextResponse.json({
      levels: levels.map((l) => ({ warehouseId: l.warehouseId.toString(), warehouseName: warehouseNameById.get(l.warehouseId.toString()) || "Unknown", quantity: l.quantity })),
      lots: fefoSort(lots).map((l) => ({
        lotNumber: l.lotNumber, expiryDate: l.expiryDate || null, daysToExpiry: daysUntilExpiry(l.expiryDate), quantity: l.quantity,
        warehouseId: l.warehouseId.toString(), warehouseName: warehouseNameById.get(l.warehouseId.toString()) || "Unknown",
      })),
      movements: movements.map((m) => ({
        warehouseId: m.warehouseId.toString(), warehouseName: warehouseNameById.get(m.warehouseId.toString()) || "Unknown",
        type: m.type, delta: m.delta, relatedPurchaseOrderId: m.relatedPurchaseOrderId ? m.relatedPurchaseOrderId.toString() : null,
        note: m.note, lots: m.lots || null, actorEmail: m.actorEmail, createdAt: m.createdAt,
      })),
    });
  } catch (err) {
    console.error("orgs/inventory/products/[productId]/stock failed:", err);
    return NextResponse.json({ error: "Could not fetch stock levels." }, { status: 500 });
  }
}
