// app/api/orgs/business-events/[eventId]/verify/route.js
//
// POST /api/orgs/business-events/:eventId/verify
// Body: { orgId, passport } — independently verifies a previously
// generated passport (SOW §17.4): VERIFIED | INVALID | INCOMPLETE | UNKNOWN.
// Deliberately takes the passport as input rather than re-fetching a
// stored one — a passport is meant to be handed to a third party and
// re-verified from what THEY hold, not from Inaya's own copy.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../lib/orgs.js";
import { verifyBusinessEventPassport } from "../../../../../../lib/businessEventPassport.js";

export async function POST(req) {
  try {
    const { orgId, passport } = await req.json();
    if (!orgId || !passport) return NextResponse.json({ error: "orgId and passport are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await verifyBusinessEventPassport(passport);
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/business-events/[eventId]/verify POST failed:", err);
    return NextResponse.json({ error: "Could not verify this passport." }, { status: 500 });
  }
}
