// app/api/orgs/private-capital/reporting/investor/route.js
// GET ?orgId=&investorId=&fundId= -> one LP's capital account + portfolio exposure report

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../lib/industry-config.js";
import { getInvestorReport } from "../../../../../../lib/private-capital-reporting.js";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const investorId = searchParams.get("investorId");
    const fundId = searchParams.get("fundId");
    if (!orgId || !investorId || !fundId) return NextResponse.json({ error: "orgId, investorId, and fundId are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "private_capital");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await getInvestorReport({ orgId, investorId, fundId, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/private-capital/reporting/investor GET failed:", err);
    return NextResponse.json({ error: "Could not fetch investor report." }, { status: 500 });
  }
}
