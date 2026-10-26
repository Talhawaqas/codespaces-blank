// app/api/orgs/inventory/production/[orderId]/transition/route.js
//
// POST { orgId, action: "start" | "complete" | "cancel", lotNumber?, expiryDate? }
//   -> start checks the components are in stock; complete uses them and books
//      the finished goods into a batch (lotNumber defaults to the order number);
//      cancel stops an order that hasn't completed. See src/lib/production.js.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { transitionProductionOrder, serializeProductionOrder, productionNames as names } from "../../../../../../../lib/production.js";

export async function POST(req, { params }) {
  try {
    let body = {}; try { body = await req.json(); } catch { body = {}; }
    if (!body.orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    await ensureOrgIndexes();
    const auth = await requireMembership(req, body.orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const result = await transitionProductionOrder({ orgId: body.orgId, orderId: params.orderId, action: body.action, membership: auth.membership, actorEmail: auth.session.email, lotNumber: body.lotNumber, expiryDate: body.expiryDate });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(serializeProductionOrder(result.order, await names(body.orgId, [result.order])));
  } catch (err) {
    console.error("orgs/inventory/production transition failed:", err);
    return NextResponse.json({ error: "Could not update the production order." }, { status: 500 });
  }
}
