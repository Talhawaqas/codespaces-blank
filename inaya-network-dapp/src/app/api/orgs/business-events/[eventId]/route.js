// app/api/orgs/business-events/[eventId]/route.js
//
// GET /api/orgs/business-events/:eventId?orgId=...
// Returns the event plus its merged timeline (SOW §16).

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { getBusinessEvent, getBusinessEventTimeline } from "../../../../../lib/businessEvents.js";

export async function GET(req, { params }) {
  try {
    const { eventId } = await params;
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const got = await getBusinessEvent({ orgId, eventId, membership: auth.membership });
    if (got.error) return NextResponse.json({ error: got.error }, { status: got.status });

    const timeline = await getBusinessEventTimeline({ orgId, eventId, membership: auth.membership });
    const e = got.event;

    return NextResponse.json({
      event: {
        id: e._id.toString(), orgId: e.orgId.toString(), departmentId: e.departmentId ? e.departmentId.toString() : null,
        eventType: e.eventType, subjectType: e.subjectType, subjectId: e.subjectId.toString(), subjectSummary: e.subjectSummary,
        status: e.status, riskLevel: e.riskLevel,
        relationships: (e.relationships || []).map((r) => ({ type: r.type, targetType: r.targetType, targetId: r.targetId.toString(), note: r.note })),
        createdByEmail: e.createdByEmail, createdAt: e.createdAt, updatedAt: e.updatedAt, completedAt: e.completedAt,
      },
      timeline: timeline.timeline.map((t) => ({ recordType: t.recordType, recordId: t.recordId.toString(), action: t.action, actorEmail: t.actorEmail, timestamp: t.timestamp, previousState: t.previousState, newState: t.newState })),
    });
  } catch (err) {
    console.error("orgs/business-events/[eventId] GET failed:", err);
    return NextResponse.json({ error: "Could not fetch the business event." }, { status: 500 });
  }
}
