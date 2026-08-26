// app/api/orgs/crm/deals/[dealId]/activity/route.js
//
// GET /api/orgs/crm/deals/:dealId/activity?orgId=... — the deal's history
// from org_activity, filtered to {recordType:"DEAL", recordId:dealId}.

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, canAccessDepartment, toObjectId } from "../../../../../../../lib/orgs.js";
import { listOrgActivityForRecord } from "../../../../../../../lib/org-activity-log.js";

export async function GET(req, { params }) {
  try {
    const { dealId } = params;
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { crmDeals } = await getOrgCollections();
    const deal = await crmDeals.findOne({ _id: toObjectId(dealId), orgId: toObjectId(orgId) });
    if (!deal) return NextResponse.json({ error: "Deal not found." }, { status: 404 });
    if (!canAccessDepartment(auth.membership, deal.departmentId)) return NextResponse.json({ error: "Deal not found." }, { status: 404 });

    const events = await listOrgActivityForRecord({ orgId, recordType: "DEAL", recordId: dealId });
    return NextResponse.json({
      activity: events.map((e) => ({ eventId: e.eventId, actorEmail: e.actorEmail, action: e.action, previousState: e.previousState, newState: e.newState, metadata: e.metadata || {}, timestamp: e.timestamp })),
    });
  } catch (err) {
    console.error("orgs/crm/deals/[dealId]/activity failed:", err);
    return NextResponse.json({ error: "Could not fetch deal activity." }, { status: 500 });
  }
}
