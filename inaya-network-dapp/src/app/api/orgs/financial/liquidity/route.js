// app/api/orgs/financial/liquidity/route.js
// GET  ?orgId=&fundId= -> the fund's current liquidity profile
// POST { orgId, fundId, redemptionProfile?, lockups?, gates?, sidePockets?, expectedCashNeeds? } -> update it

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessFinancialEntities } from "../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../lib/industry-config.js";
import { recordLiquidityProfile, getFundLiquidityProfile } from "../../../../../lib/liquidity-management.js";

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

    const profile = await getFundLiquidityProfile(orgId, fundId);
    return NextResponse.json({ liquidityProfile: profile });
  } catch (err) {
    console.error("orgs/financial/liquidity GET failed:", err);
    return NextResponse.json({ error: "Could not fetch liquidity profile." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { orgId, fundId } = body;
    if (!orgId || !fundId) return NextResponse.json({ error: "orgId and fundId are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "financial");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await recordLiquidityProfile({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/financial/liquidity POST failed:", err);
    return NextResponse.json({ error: "Could not update liquidity profile." }, { status: 500 });
  }
}
