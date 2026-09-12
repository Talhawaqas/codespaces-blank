// app/api/orgs/inventory/transfers/route.js
//
// POST /api/orgs/inventory/transfers
// Body: { orgId, productId, sourceWarehouseId, destWarehouseId, quantity, note? }
// Thin wrapper over inventory.js's transferStock() — see that function's
// own header comment for the reuse rationale (recordStockMovement twice,
// nothing new).

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessDepartment, toObjectId, getOrgCollections } from "../../../../../lib/orgs.js";
import { transferStock } from "../../../../../lib/inventory.js";

export async function POST(req) {
  try {
    const { orgId, productId, sourceWarehouseId, destWarehouseId, quantity, note } = await req.json();
    if (!orgId || !productId || !sourceWarehouseId || !destWarehouseId) {
      return NextResponse.json({ error: "orgId, productId, sourceWarehouseId, and destWarehouseId are required." }, { status: 400 });
    }

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { products, warehouses } = await getOrgCollections();
    const orgObjectId = toObjectId(orgId);
    const product = await products.findOne({ _id: toObjectId(productId), orgId: orgObjectId, deletedAt: null });
    if (!product) return NextResponse.json({ error: "Product not found." }, { status: 404 });
    if (!canAccessDepartment(auth.membership, product.departmentId)) return NextResponse.json({ error: "You don't have permission to do that." }, { status: 403 });

    const [source, dest] = await Promise.all([
      warehouses.findOne({ _id: toObjectId(sourceWarehouseId), orgId: orgObjectId }),
      warehouses.findOne({ _id: toObjectId(destWarehouseId), orgId: orgObjectId }),
    ]);
    if (!source || !dest) return NextResponse.json({ error: "Source or destination warehouse not found." }, { status: 404 });

    const result = await transferStock({ orgId, productId, sourceWarehouseId, destWarehouseId, quantity: Number(quantity), note, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ transferId: result.transferId, newSourceQuantity: result.from.newQuantity, newDestQuantity: result.to.newQuantity });
  } catch (err) {
    console.error("orgs/inventory/transfers POST failed:", err);
    return NextResponse.json({ error: "Could not transfer inventory." }, { status: 500 });
  }
}
