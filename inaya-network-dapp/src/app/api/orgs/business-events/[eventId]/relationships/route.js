// app/api/orgs/business-events/[eventId]/relationships/route.js
//
// POST /api/orgs/business-events/:eventId/relationships
// Body: { orgId, type, targetType, targetId, note? }

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../lib/orgs.js";
import { addBusinessEventRelationship } from "../../../../../../lib/businessEvents.js";

export async function POST(req, { params }) {
  try {
    const { eventId } = await params;
    const { orgId, type, targetType, targetId, note } = await req.json();
    if (!orgId || !type || !targetType || !targetId) return NextResponse.json({ error: "orgId, type, targetType and targetId are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await addBusinessEventRelationship({ orgId, eventId, type, targetType, targetId, note, membership: auth.membership, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("orgs/business-events/[eventId]/relationships POST failed:", err);
    return NextResponse.json({ error: "Could not attach evidence to this event." }, { status: 500 });
  }
}
