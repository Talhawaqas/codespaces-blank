// app/api/orgs/inventory/movements/route.js
//
// POST /api/orgs/inventory/movements  { orgId, productId, warehouseId, type, quantity, note? }
//   -> records a MANUAL stock movement (stock-in, stock-out, or
//      adjustment) — the counterpart to the automatic RECEIPT movements
//      purchase-order-workflow.js's receivePurchaseOrder() posts. `type`
//      is "RECEIPT" (manual stock-in, delta=+quantity), "ISSUE" (stock-
//      out, delta=-quantity), or "ADJUSTMENT" (either sign — quantity can
//      be negative here to correct a count down).
// GET  /api/orgs/inventory/movements?orgId=...&departmentId=...&limit=
//   -> recent movements across every product in an accessible department,
//      newest first — the org-wide inventory activity feed.

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, canAccessDepartment, toObjectId } from "../../../../../lib/orgs.js";
import { getAccessibleScope } from "../../../../../lib/document-permissions.js";
import { recordStockMovement } from "../../../../../lib/inventory.js";

const MANUAL_TYPES = ["RECEIPT", "ISSUE", "ADJUSTMENT"];

export async function POST(req) {
  try {
    const { orgId, productId, warehouseId, type, quantity, note } = await req.json();
    if (!orgId || !productId || !warehouseId) return NextResponse.json({ error: "orgId, productId, and warehouseId are required." }, { status: 400 });
    if (!MANUAL_TYPES.includes(type)) return NextResponse.json({ error: "type must be RECEIPT, ISSUE, or ADJUSTMENT." }, { status: 400 });
    if (!Number.isFinite(quantity) || quantity === 0) return NextResponse.json({ error: "quantity must be a non-zero number." }, { status: 400 });
    if (type !== "ADJUSTMENT" && quantity < 0) return NextResponse.json({ error: `quantity must be positive for ${type}.` }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { products, warehouses } = await getOrgCollections();
    const orgObjectId = toObjectId(orgId);
    const productObjectId = toObjectId(productId);
    const warehouseObjectId = toObjectId(warehouseId);

    const product = await products.findOne({ _id: productObjectId, orgId: orgObjectId, deletedAt: null });
    if (!product) return NextResponse.json({ error: "Product not found." }, { status: 404 });
    if (!canAccessDepartment(auth.membership, product.departmentId)) return NextResponse.json({ error: "Product not found." }, { status: 404 });

    const warehouse = await warehouses.findOne({ _id: warehouseObjectId, orgId: orgObjectId });
    if (!warehouse) return NextResponse.json({ error: "Warehouse not found." }, { status: 404 });

    const delta = type === "ISSUE" ? -quantity : quantity;
    const result = await recordStockMovement({
      orgId, productId: productObjectId, warehouseId: warehouseObjectId, delta, type,
      note: note ? String(note).trim() : null, actorEmail: auth.session.email,
    });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });

    return NextResponse.json({ newQuantity: result.newQuantity, movement: { type, delta, createdAt: result.movement.createdAt } });
  } catch (err) {
    console.error("orgs/inventory/movements POST failed:", err);
    return NextResponse.json({ error: "Could not record the stock movement." }, { status: 500 });
  }
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const departmentId = searchParams.get("departmentId");
    const limit = Math.min(parseInt(searchParams.get("limit") || "30", 10) || 30, 100);
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const scope = await getAccessibleScope({ orgId, membership: auth.membership, email: auth.session.email });
    let visibleProducts = scope.visibleProducts;
    if (departmentId) {
      if (!canAccessDepartment(auth.membership, departmentId)) {
        return NextResponse.json({ error: "You don't have access to this department." }, { status: 403 });
      }
      visibleProducts = visibleProducts.filter((p) => p.departmentId.toString() === departmentId);
    }
    const productIds = visibleProducts.map((p) => p._id);
    if (productIds.length === 0) return NextResponse.json({ movements: [] });

    const { stockMovements, warehouses } = await getOrgCollections();
    const orgObjectId = toObjectId(orgId);
    const [movements, allWarehouses] = await Promise.all([
      stockMovements.find({ orgId: orgObjectId, productId: { $in: productIds } }).sort({ createdAt: -1 }).limit(limit).toArray(),
      warehouses.find({ orgId: orgObjectId }).toArray(),
    ]);
    const productNameById = new Map(visibleProducts.map((p) => [p._id.toString(), p.name]));
    const warehouseNameById = new Map(allWarehouses.map((w) => [w._id.toString(), w.name]));

    return NextResponse.json({
      movements: movements.map((m) => ({
        productId: m.productId.toString(), productName: productNameById.get(m.productId.toString()) || "Unknown",
        warehouseId: m.warehouseId.toString(), warehouseName: warehouseNameById.get(m.warehouseId.toString()) || "Unknown",
        type: m.type, delta: m.delta, relatedPurchaseOrderId: m.relatedPurchaseOrderId ? m.relatedPurchaseOrderId.toString() : null,
        note: m.note, actorEmail: m.actorEmail, createdAt: m.createdAt,
      })),
    });
  } catch (err) {
    console.error("orgs/inventory/movements GET failed:", err);
    return NextResponse.json({ error: "Could not fetch stock movements." }, { status: 500 });
  }
}
