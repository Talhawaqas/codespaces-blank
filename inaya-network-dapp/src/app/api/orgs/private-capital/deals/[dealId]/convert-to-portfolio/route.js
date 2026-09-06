// app/api/orgs/private-capital/deals/[dealId]/convert-to-portfolio/route.js
// POST { orgId } -> the only path from CLOSING to PORTFOLIO; creates a real portfolio_companies workspace

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../../lib/industry-config.js";
import { convertToPortfolio } from "../../../../../../../lib/deal-pipeline.js";

export async function POST(req, { params }) {
  try {
    const { dealId } = await params;
    const { orgId } = await req.json();
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "private_capital");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await convertToPortfolio({ orgId, dealId, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({
      deal: { id: result.deal._id.toString(), stage: result.deal.stage, portfolioCompanyId: result.deal.portfolioCompanyId.toString() },
      portfolioCompany: { id: result.portfolioCompany._id.toString(), name: result.portfolioCompany.name },
    });
  } catch (err) {
    console.error("orgs/private-capital/deals/[dealId]/convert-to-portfolio POST failed:", err);
    return NextResponse.json({ error: "Could not convert deal to portfolio." }, { status: 500 });
  }
}
