// app/api/orgs/private-capital/portfolio-companies/[portfolioCompanyId]/kpis/route.js
// GET  ?orgId= -> list KPI definitions (with their value history) for this company
// POST { orgId, key, label, unit? } -> define a new KPI (user-created, never a hardcoded industry list)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessFinancialEntities } from "../../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../../lib/industry-config.js";
import { defineKpi, listKpiDefinitions, listKpiValues } from "../../../../../../../lib/portfolio-kpis.js";

export async function GET(req, { params }) {
  try {
    const { portfolioCompanyId } = await params;
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "private_capital");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });
    if (!canAccessFinancialEntities(auth.membership)) return NextResponse.json({ error: "You don't have financial-entities access." }, { status: 403 });

    const definitions = await listKpiDefinitions(orgId, portfolioCompanyId);
    const kpis = await Promise.all(definitions.map(async (def) => ({
      id: def._id.toString(), key: def.key, label: def.label, unit: def.unit,
      values: (await listKpiValues(orgId, def._id)).map((v) => ({ period: v.period, value: v.value })),
    })));
    return NextResponse.json({ kpis });
  } catch (err) {
    console.error("orgs/private-capital/portfolio-companies/[id]/kpis GET failed:", err);
    return NextResponse.json({ error: "Could not fetch KPIs." }, { status: 500 });
  }
}

export async function POST(req, { params }) {
  try {
    const { portfolioCompanyId } = await params;
    const body = await req.json();
    const { orgId, key, label } = body;
    if (!orgId || !key || !label) return NextResponse.json({ error: "orgId, key, and label are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "private_capital");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await defineKpi({ ...body, portfolioCompanyId, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ kpiDefinition: { id: result.kpiDefinition._id.toString(), key: result.kpiDefinition.key, label: result.kpiDefinition.label, unit: result.kpiDefinition.unit } });
  } catch (err) {
    console.error("orgs/private-capital/portfolio-companies/[id]/kpis POST failed:", err);
    return NextResponse.json({ error: "Could not define KPI." }, { status: 500 });
  }
}
