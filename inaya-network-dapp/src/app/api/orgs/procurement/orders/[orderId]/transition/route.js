// app/api/orgs/procurement/orders/[orderId]/transition/route.js
//
// POST /api/orgs/procurement/orders/:orderId/transition
// Body: { orgId, action, note? } — action is one of: submit, approve, reject, order, cancel
// (NOT "receive" — that's its own route, receive/route.js, since it
// carries a quantity payload rather than a fixed target status.)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { transitionPurchaseOrder } from "../../../../../../../lib/purchase-order-workflow.js";

export async function POST(req, { params }) {
  try {
    const { orderId } = params;
    const { orgId, action, note } = await req.json();
    if (!orgId || !action) return NextResponse.json({ error: "orgId and action are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await transitionPurchaseOrder({ orgId, poId: orderId, action, membership: auth.membership, actorEmail: auth.session.email, note });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });

    return NextResponse.json({ status: result.po.status, updatedAt: result.po.updatedAt });
  } catch (err) {
    console.error("orgs/procurement/orders/[orderId]/transition failed:", err);
    return NextResponse.json({ error: "Could not update the purchase order's status." }, { status: 500 });
  }
}
