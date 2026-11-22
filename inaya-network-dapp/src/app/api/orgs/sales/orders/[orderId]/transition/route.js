// app/api/orgs/sales/orders/[orderId]/transition/route.js
//
// POST { orgId, action, ...input } -- actions: accept | confirm (allowBackorder?) | reserve | pick | pack | ready | fulfil |
//   deliver (note?) | invoice | cancel (reason?) | payment { method, amount, reference? } | refund { method, amount, reference?, reason }
//   | return { lines: [{ lineIndex, quantity, disposition }], reason }
//   -> moves a sales order along its workflow (src/lib/sales-orders.js):
//      confirm checks stock, fulfil dispatches it (batches earliest-expiry
//      first), invoice raises a DRAFT invoice, cancel stops a not-yet-
//      dispatched order.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { transitionSalesOrder } from "../../../../../../../lib/sales-orders.js";

export async function POST(req, { params }) {
  params = await params; // Next.js 15: params is a Promise (SQA 17 Nov 2026)
  try {
    let body = {}; try { body = await req.json(); } catch { body = {}; }
    if (!body.orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    await ensureOrgIndexes();
    const auth = await requireMembership(req, body.orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const result = await transitionSalesOrder({ orgId: body.orgId, orderId: params.orderId, action: body.action, membership: auth.membership, actorEmail: auth.session.email, input: body });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result.order);
  } catch (err) {
    console.error("orgs/sales/orders transition failed:", err);
    return NextResponse.json({ error: "Could not update the sales order." }, { status: 500 });
  }
}
