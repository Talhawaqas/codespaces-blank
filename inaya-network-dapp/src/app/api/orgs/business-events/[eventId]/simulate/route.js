// app/api/orgs/business-events/[eventId]/simulate/route.js
//
// POST /api/orgs/business-events/:eventId/simulate
// Body: { orgId, action } — What If (SOW §18). Read-only: never calls any
// real transition function. See businessEventSimulate.js's header for the
// explicit no-write guarantee this route depends on.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../lib/orgs.js";
import { simulateBusinessEventDecision } from "../../../../../../lib/businessEventSimulate.js";

export async function POST(req, { params }) {
  try {
    const { eventId } = await params;
    const { orgId, action } = await req.json();
    if (!orgId || !action) return NextResponse.json({ error: "orgId and action are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await simulateBusinessEventDecision({ orgId, eventId, action, membership: auth.membership, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });

    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/business-events/[eventId]/simulate POST failed:", err);
    return NextResponse.json({ error: "Could not simulate this decision." }, { status: 500 });
  }
}
