// app/api/orgs/private-capital/portfolio-companies/route.js
// GET   ?orgId=&fundId=&status= -> list portfolio companies
// POST  { orgId, fundId, name, ... } -> onboard an existing portfolio company with no deal record
//   (the normal path is deals/[dealId]/convert-to-portfolio)
// PATCH { orgId, portfolioCompanyId, status } -> active / exited / written_off

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessFinancialEntities } from "../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../lib/industry-config.js";
import { createPortfolioCompany, updatePortfolioCompanyStatus, listPortfolioCompanies } from "../../../../../lib/portfolio-company.js";

function serialize(c) {
  return { id: c._id.toString(), fundId: c.fundId.toString(), name: c.name, dealId: c.dealId?.toString() || null, sector: c.sector, geography: c.geography, status: c.status };
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

    const companies = await listPortfolioCompanies(orgId, { fundId: searchParams.get("fundId") || undefined, status: searchParams.get("status") || undefined });
    return NextResponse.json({ portfolioCompanies: companies.map(serialize) });
  } catch (err) {
    console.error("orgs/private-capital/portfolio-companies GET failed:", err);
    return NextResponse.json({ error: "Could not fetch portfolio companies." }, { status: 500 });
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

    const verticalCheck = await requireVertical(orgId, "private_capital");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await createPortfolioCompany({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ portfolioCompany: serialize(result.portfolioCompany) });
  } catch (err) {
    console.error("orgs/private-capital/portfolio-companies POST failed:", err);
    return NextResponse.json({ error: "Could not create portfolio company." }, { status: 500 });
  }
}

export async function PATCH(req) {
  try {
    const { orgId, portfolioCompanyId, status } = await req.json();
    if (!orgId || !portfolioCompanyId || !status) return NextResponse.json({ error: "orgId, portfolioCompanyId, and status are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "private_capital");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await updatePortfolioCompanyStatus({ orgId, portfolioCompanyId, status, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ portfolioCompany: serialize(result.portfolioCompany) });
  } catch (err) {
    console.error("orgs/private-capital/portfolio-companies PATCH failed:", err);
    return NextResponse.json({ error: "Could not update portfolio company." }, { status: 500 });
  }
}
