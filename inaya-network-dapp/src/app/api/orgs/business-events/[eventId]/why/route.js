// app/api/orgs/business-events/[eventId]/why/route.js
//
// GET /api/orgs/business-events/:eventId/why?orgId=...
// Provenance/explainability (SOW §12) — never chain-of-thought.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../lib/orgs.js";
import { explainBusinessEvent } from "../../../../../../lib/businessEventExplain.js";

export async function GET(req, { params }) {
  try {
    const { eventId } = await params;
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await explainBusinessEvent({ orgId, eventId, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });

    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/business-events/[eventId]/why GET failed:", err);
    return NextResponse.json({ error: "Could not explain this business event." }, { status: 500 });
  }
}
