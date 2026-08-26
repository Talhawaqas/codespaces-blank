// app/api/orgs/procurement/orders/[orderId]/activity/route.js
//
// GET /api/orgs/procurement/orders/:orderId/activity?orgId=...

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, canAccessDepartment, toObjectId } from "../../../../../../../lib/orgs.js";
import { listOrgActivityForRecord } from "../../../../../../../lib/org-activity-log.js";

export async function GET(req, { params }) {
  try {
    const { orderId } = params;
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { purchaseOrders } = await getOrgCollections();
    const po = await purchaseOrders.findOne({ _id: toObjectId(orderId), orgId: toObjectId(orgId) });
    if (!po) return NextResponse.json({ error: "Purchase order not found." }, { status: 404 });
    if (!canAccessDepartment(auth.membership, po.departmentId)) return NextResponse.json({ error: "Purchase order not found." }, { status: 404 });

    const events = await listOrgActivityForRecord({ orgId, recordType: "PURCHASE_ORDER", recordId: orderId });
    return NextResponse.json({
      activity: events.map((e) => ({ eventId: e.eventId, actorEmail: e.actorEmail, action: e.action, previousState: e.previousState, newState: e.newState, metadata: e.metadata || {}, timestamp: e.timestamp })),
    });
  } catch (err) {
    console.error("orgs/procurement/orders/[orderId]/activity failed:", err);
    return NextResponse.json({ error: "Could not fetch purchase order activity." }, { status: 500 });
  }
}
