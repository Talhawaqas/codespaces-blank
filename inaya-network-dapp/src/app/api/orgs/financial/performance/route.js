// app/api/orgs/financial/performance/route.js
// GET  ?orgId=&fundId= -> list performance periods (ordered chronologically)
// POST { orgId, fundId, period, nav?, netReturn?, ... } -> record/update one period's performance

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessFinancialEntities } from "../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../lib/industry-config.js";
import { recordPerformancePeriod, listPerformance } from "../../../../../lib/performance-analytics.js";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const fundId = searchParams.get("fundId");
    if (!orgId || !fundId) return NextResponse.json({ error: "orgId and fundId are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "financial");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });
    if (!canAccessFinancialEntities(auth.membership)) return NextResponse.json({ error: "You don't have financial-entities access." }, { status: 403 });

    const periods = await listPerformance(orgId, fundId);
    return NextResponse.json({ periods: periods.map((p) => ({ period: p.period, inputs: p.inputs, derived: p.derived })) });
  } catch (err) {
    console.error("orgs/financial/performance GET failed:", err);
    return NextResponse.json({ error: "Could not fetch performance." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { orgId, fundId, period } = body;
    if (!orgId || !fundId || !period) return NextResponse.json({ error: "orgId, fundId, and period are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "financial");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await recordPerformancePeriod({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ period: result.performance.period, inputs: result.performance.inputs, derived: result.performance.derived });
  } catch (err) {
    console.error("orgs/financial/performance POST failed:", err);
    return NextResponse.json({ error: "Could not record performance." }, { status: 500 });
  }
}
