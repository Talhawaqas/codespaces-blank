// app/api/orgs/private-capital/kpis/[kpiId]/values/route.js
// POST { orgId, period, value } -> record/update one period's KPI value (upsert by period)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../../lib/industry-config.js";
import { recordKpiValue } from "../../../../../../../lib/portfolio-kpis.js";

export async function POST(req, { params }) {
  try {
    const { kpiId } = await params;
    const body = await req.json();
    const { orgId, period, value } = body;
    if (!orgId || !period || typeof value !== "number") return NextResponse.json({ error: "orgId, period, and a numeric value are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "private_capital");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await recordKpiValue({ orgId, kpiDefinitionId: kpiId, period, value, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/private-capital/kpis/[kpiId]/values POST failed:", err);
    return NextResponse.json({ error: "Could not record KPI value." }, { status: 500 });
  }
}
