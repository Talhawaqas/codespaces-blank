// app/api/orgs/procurement/orders/[orderId]/items/route.js
//
// PATCH /api/orgs/procurement/orders/:orderId/items
// Body: { orgId, items: [{ description, sku?, productId?, warehouseId?, quantity, unitPrice? }] }
// Only succeeds while the PO is DRAFT — see updatePurchaseOrderItems()'s
// own header comment for why that's the right boundary.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { updatePurchaseOrderItems } from "../../../../../../../lib/purchase-order-workflow.js";

export async function PATCH(req, { params }) {
  try {
    const { orderId } = params;
    const { orgId, items } = await req.json();
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await updatePurchaseOrderItems({ orgId, poId: orderId, items, membership: auth.membership, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ status: result.po.status, items: result.po.items });
  } catch (err) {
    console.error("orgs/procurement/orders/[orderId]/items PATCH failed:", err);
    return NextResponse.json({ error: "Could not update the purchase order's line items." }, { status: 500 });
  }
}
