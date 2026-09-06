// app/api/orgs/financial/portfolios/route.js
// GET  ?orgId=&fundId= -> list portfolios
// POST { orgId, fundId, name, benchmark? } -> create a portfolio

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessFinancialEntities } from "../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../lib/industry-config.js";
import { createPortfolio, listPortfolios } from "../../../../../lib/portfolio-management.js";

function serialize(p) {
  return { id: p._id.toString(), fundId: p.fundId.toString(), name: p.name, benchmark: p.benchmark };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "financial");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });
    if (!canAccessFinancialEntities(auth.membership)) return NextResponse.json({ error: "You don't have financial-entities access." }, { status: 403 });

    const portfolios = await listPortfolios(orgId, { fundId: searchParams.get("fundId") || undefined });
    return NextResponse.json({ portfolios: portfolios.map(serialize) });
  } catch (err) {
    console.error("orgs/financial/portfolios GET failed:", err);
    return NextResponse.json({ error: "Could not fetch portfolios." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { orgId, fundId, name } = body;
    if (!orgId || !fundId || !name) return NextResponse.json({ error: "orgId, fundId, and name are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "financial");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await createPortfolio({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ portfolio: serialize(result.portfolio) });
  } catch (err) {
    console.error("orgs/financial/portfolios POST failed:", err);
    return NextResponse.json({ error: "Could not create portfolio." }, { status: 500 });
  }
}
