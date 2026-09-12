// app/api/orgs/insights/route.js
//
// GET /api/orgs/insights?orgId=...&periodDays=30
// GET /api/orgs/insights?orgId=...&startDate=2026-01-01&endDate=2026-01-31
// Thin wrapper over business-insights.js's computeBusinessInsights() —
// same requireMembership() gate every other org route uses; the real
// permission scoping happens inside getAccessibleScope(), not here.
// startDate/endDate (Custom Date-Range Picker) override periodDays when
// both are present; omitting them keeps the existing preset behavior.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../lib/orgs.js";
import { computeBusinessInsights } from "../../../../lib/business-insights.js";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const periodDays = searchParams.get("periodDays");
    const startDate = searchParams.get("startDate");
    const endDate = searchParams.get("endDate");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const insights = await computeBusinessInsights({ orgId, membership: auth.membership, email: auth.session.email, periodDays, startDate, endDate });
    return NextResponse.json(insights);
  } catch (err) {
    if (err.message?.startsWith("Invalid date range")) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error("orgs/insights failed:", err);
    return NextResponse.json({ error: "Could not load business insights." }, { status: 500 });
  }
}
