// app/api/orgs/business-events/route.js
//
// GET  /api/orgs/business-events?orgId=...&status=...&subjectType=...
// POST /api/orgs/business-events  { orgId, subjectType, subjectId, relationships? }
//   subjectType: INVOICE | PURCHASE_ORDER | PURCHASE_REQUEST | AI_ACTION_REQUEST
//   relationships?: [{ type, targetType, targetId, note? }]

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../lib/orgs.js";
import { createBusinessEvent, listBusinessEvents } from "../../../../lib/businessEvents.js";

function serializeEvent(e) {
  return {
    id: e._id.toString(), orgId: e.orgId.toString(), departmentId: e.departmentId ? e.departmentId.toString() : null,
    eventType: e.eventType, subjectType: e.subjectType, subjectId: e.subjectId.toString(), subjectSummary: e.subjectSummary,
    status: e.status, riskLevel: e.riskLevel,
    relationships: (e.relationships || []).map((r) => ({ type: r.type, targetType: r.targetType, targetId: r.targetId.toString(), note: r.note })),
    createdByEmail: e.createdByEmail, createdAt: e.createdAt, updatedAt: e.updatedAt, completedAt: e.completedAt,
  };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const status = searchParams.get("status");
    const subjectType = searchParams.get("subjectType");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const events = await listBusinessEvents({ orgId, membership: auth.membership, status, subjectType });
    return NextResponse.json({ events: events.map(serializeEvent) });
  } catch (err) {
    console.error("orgs/business-events GET failed:", err);
    return NextResponse.json({ error: "Could not fetch business events." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const { orgId, subjectType, subjectId, relationships } = await req.json();
    if (!orgId || !subjectType || !subjectId) return NextResponse.json({ error: "orgId, subjectType and subjectId are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await createBusinessEvent({ orgId, subjectType, subjectId, relationships, membership: auth.membership, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });

    return NextResponse.json({ event: serializeEvent(result.event) }, { status: 201 });
  } catch (err) {
    console.error("orgs/business-events POST failed:", err);
    return NextResponse.json({ error: "Could not create the business event." }, { status: 500 });
  }
}
