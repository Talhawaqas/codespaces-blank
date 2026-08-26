// app/api/orgs/insights/route.js
//
// GET /api/orgs/insights?orgId=...&periodDays=30
// Thin wrapper over business-insights.js's computeBusinessInsights() —
// same requireMembership() gate every other org route uses; the real
// permission scoping happens inside getAccessibleScope(), not here.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../lib/orgs.js";
import { computeBusinessInsights } from "../../../../lib/business-insights.js";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const periodDays = searchParams.get("periodDays");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const insights = await computeBusinessInsights({ orgId, membership: auth.membership, email: auth.session.email, periodDays });
    return NextResponse.json(insights);
  } catch (err) {
    console.error("orgs/insights failed:", err);
    return NextResponse.json({ error: "Could not load business insights." }, { status: 500 });
  }
}
