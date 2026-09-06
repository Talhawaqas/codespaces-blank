// app/api/orgs/private-capital/deals/route.js
// GET   ?orgId=&fundId=&stage= -> list deals
// POST  { orgId, fundId, company, ... } -> create a deal (stage: SOURCED)
// PATCH { orgId, dealId, action, note? } -> advance/regress/pass/reopen

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessFinancialEntities } from "../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../lib/industry-config.js";
import { createDeal, transitionDeal, listDeals } from "../../../../../lib/deal-pipeline.js";

function serialize(d) {
  return {
    id: d._id.toString(), fundId: d.fundId.toString(), company: d.company, founder: d.founder,
    sector: d.sector, geography: d.geography, dealSource: d.dealSource, valuation: d.valuation,
    round: d.round, ownershipTarget: d.ownershipTarget, checkSize: d.checkSize,
    partnerEmail: d.partnerEmail, leadEmail: d.leadEmail, coInvestors: d.coInvestors,
    probability: d.probability, timeline: d.timeline, nextAction: d.nextAction,
    portfolioCompanyId: d.portfolioCompanyId?.toString() || null, stage: d.stage,
  };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "private_capital");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });
    if (!canAccessFinancialEntities(auth.membership)) return NextResponse.json({ error: "You don't have financial-entities access." }, { status: 403 });

    const deals = await listDeals(orgId, { fundId: searchParams.get("fundId") || undefined, stage: searchParams.get("stage") || undefined });
    return NextResponse.json({ deals: deals.map(serialize) });
  } catch (err) {
    console.error("orgs/private-capital/deals GET failed:", err);
    return NextResponse.json({ error: "Could not fetch deals." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { orgId, fundId, company } = body;
    if (!orgId || !fundId || !company) return NextResponse.json({ error: "orgId, fundId, and company are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "private_capital");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await createDeal({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ deal: serialize(result.deal) });
  } catch (err) {
    console.error("orgs/private-capital/deals POST failed:", err);
    return NextResponse.json({ error: "Could not create deal." }, { status: 500 });
  }
}

export async function PATCH(req) {
  try {
    const { orgId, dealId, action, note } = await req.json();
    if (!orgId || !dealId || !action) return NextResponse.json({ error: "orgId, dealId, and action are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "private_capital");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await transitionDeal({ orgId, dealId, action, note, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ deal: serialize(result.deal) });
  } catch (err) {
    console.error("orgs/private-capital/deals PATCH failed:", err);
    return NextResponse.json({ error: "Could not update deal." }, { status: 500 });
  }
}
