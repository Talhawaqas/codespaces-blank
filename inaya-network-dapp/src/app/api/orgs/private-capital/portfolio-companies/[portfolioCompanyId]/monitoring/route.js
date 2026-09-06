// app/api/orgs/private-capital/portfolio-companies/[portfolioCompanyId]/monitoring/route.js
// GET ?orgId= -> the monitoring snapshot (KPI trend, upcoming board deadlines, open action items,
//   value-creation plan status) -- explicitly labels what it does NOT cover, never fabricates it

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessFinancialEntities } from "../../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../../lib/industry-config.js";
import { getPortfolioMonitoring } from "../../../../../../../lib/portfolio-kpis.js";

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

    const monitoring = await getPortfolioMonitoring(orgId, portfolioCompanyId);
    return NextResponse.json(monitoring);
  } catch (err) {
    console.error("orgs/private-capital/portfolio-companies/[id]/monitoring GET failed:", err);
    return NextResponse.json({ error: "Could not fetch monitoring." }, { status: 500 });
  }
}
