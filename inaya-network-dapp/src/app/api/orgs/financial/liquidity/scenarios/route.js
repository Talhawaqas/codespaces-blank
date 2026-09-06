// app/api/orgs/financial/liquidity/scenarios/route.js
// GET  ?orgId=&fundId= -> list liquidity scenario runs
// POST { orgId, fundId, scenarioType, buckets, assumptions? } -> run a new scenario (immutable record)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessFinancialEntities } from "../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../lib/industry-config.js";
import { runLiquidityScenario, listLiquidityScenarios } from "../../../../../../lib/liquidity-management.js";

function serialize(s) {
  return { id: s._id.toString(), scenarioType: s.scenarioType, totalValue: s.totalValue, liquidWithin7Days: s.liquidWithin7Days, liquidWithin30Days: s.liquidWithin30Days, assumptions: s.assumptions, dataTimestamp: s.dataTimestamp };
}

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

    const scenarios = await listLiquidityScenarios(orgId, fundId);
    return NextResponse.json({ scenarios: scenarios.map(serialize) });
  } catch (err) {
    console.error("orgs/financial/liquidity/scenarios GET failed:", err);
    return NextResponse.json({ error: "Could not fetch liquidity scenarios." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { orgId, fundId, scenarioType, buckets } = body;
    if (!orgId || !fundId || !scenarioType || !buckets) return NextResponse.json({ error: "orgId, fundId, scenarioType, and buckets are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "financial");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await runLiquidityScenario({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ scenario: serialize(result.scenario) });
  } catch (err) {
    console.error("orgs/financial/liquidity/scenarios POST failed:", err);
    return NextResponse.json({ error: "Could not run liquidity scenario." }, { status: 500 });
  }
}
