// app/api/orgs/procurement/orders/[orderId]/receive/route.js
//
// POST /api/orgs/procurement/orders/:orderId/receive
// Body: { orgId, receipts: [{itemIndex, quantity}], note? }
//
// Thin wrapper over receivePurchaseOrder() (purchase-order-workflow.js) —
// see that file for the real logic: partial-receipt accumulation,
// RECEIVED/PARTIALLY_RECEIVED derivation, and the real inventory stock
// movement triggered for any item linked to a product+warehouse.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { receivePurchaseOrder } from "../../../../../../../lib/purchase-order-workflow.js";

export async function POST(req, { params }) {
  try {
    const { orderId } = params;
    const { orgId, receipts, note } = await req.json();
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await receivePurchaseOrder({ orgId, poId: orderId, receipts, membership: auth.membership, actorEmail: auth.session.email, note });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });

    return NextResponse.json({ status: result.po.status, updatedAt: result.po.updatedAt, items: result.po.items });
  } catch (err) {
    console.error("orgs/procurement/orders/[orderId]/receive failed:", err);
    return NextResponse.json({ error: "Could not record receipt of this purchase order." }, { status: 500 });
  }
}
