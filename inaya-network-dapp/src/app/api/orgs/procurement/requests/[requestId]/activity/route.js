// app/api/orgs/procurement/requests/[requestId]/activity/route.js
//
// GET /api/orgs/procurement/requests/:requestId/activity?orgId=...

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, canAccessDepartment, toObjectId } from "../../../../../../../lib/orgs.js";
import { listOrgActivityForRecord } from "../../../../../../../lib/org-activity-log.js";

export async function GET(req, { params }) {
  try {
    const { requestId } = params;
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { purchaseRequests } = await getOrgCollections();
    const request = await purchaseRequests.findOne({ _id: toObjectId(requestId), orgId: toObjectId(orgId) });
    if (!request) return NextResponse.json({ error: "Purchase request not found." }, { status: 404 });
    if (!canAccessDepartment(auth.membership, request.departmentId)) return NextResponse.json({ error: "Purchase request not found." }, { status: 404 });

    const events = await listOrgActivityForRecord({ orgId, recordType: "PURCHASE_REQUEST", recordId: requestId });
    return NextResponse.json({
      activity: events.map((e) => ({ eventId: e.eventId, actorEmail: e.actorEmail, action: e.action, previousState: e.previousState, newState: e.newState, metadata: e.metadata || {}, timestamp: e.timestamp })),
    });
  } catch (err) {
    console.error("orgs/procurement/requests/[requestId]/activity failed:", err);
    return NextResponse.json({ error: "Could not fetch request activity." }, { status: 500 });
  }
}
