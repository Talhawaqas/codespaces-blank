// app/api/orgs/financial/exposure/route.js
// GET ?orgId=&portfolioId= -> the exposure dashboard (gross/net/long/short + by issuer/sector/geography/strategy)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessFinancialEntities } from "../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../lib/industry-config.js";
import { getExposureDashboard } from "../../../../../lib/portfolio-management.js";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const portfolioId = searchParams.get("portfolioId");
    if (!orgId || !portfolioId) return NextResponse.json({ error: "orgId and portfolioId are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "financial");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });
    if (!canAccessFinancialEntities(auth.membership)) return NextResponse.json({ error: "You don't have financial-entities access." }, { status: 403 });

    const dashboard = await getExposureDashboard(orgId, portfolioId);
    return NextResponse.json(dashboard);
  } catch (err) {
    console.error("orgs/financial/exposure GET failed:", err);
    return NextResponse.json({ error: "Could not fetch exposure dashboard." }, { status: 500 });
  }
}
