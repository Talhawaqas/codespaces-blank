// app/api/orgs/financial/investors/route.js
// GET  ?orgId=&fundId= -> list investors
// POST { orgId, fundId?, legalName, entityType?, jurisdiction? } -> add an investor
// PATCH { orgId, investorId, onboardingStatus?, kycProviderStatus? } -> update onboarding

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessFinancialEntities } from "../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../lib/industry-config.js";
import { createInvestor, updateInvestorOnboarding, listInvestors } from "../../../../../lib/financial-investors.js";

function serialize(i) {
  return {
    id: i._id.toString(), fundId: i.fundId?.toString() || null, legalName: i.legalName,
    entityType: i.entityType, jurisdiction: i.jurisdiction, onboardingStatus: i.onboardingStatus,
    kycProviderStatus: i.kycProviderStatus, accreditationStatus: i.accreditationStatus,
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

    const verticalCheck = await requireVertical(orgId, ["financial", "private_capital"]);
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });
    if (!canAccessFinancialEntities(auth.membership)) return NextResponse.json({ error: "You don't have financial-entities access." }, { status: 403 });

    const investors = await listInvestors(orgId, { fundId: searchParams.get("fundId") || undefined });
    return NextResponse.json({ investors: investors.map(serialize) });
  } catch (err) {
    console.error("orgs/financial/investors GET failed:", err);
    return NextResponse.json({ error: "Could not fetch investors." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { orgId, legalName } = body;
    if (!orgId || !legalName) return NextResponse.json({ error: "orgId and legalName are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, ["financial", "private_capital"]);
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await createInvestor({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ investor: serialize(result.investor) });
  } catch (err) {
    console.error("orgs/financial/investors POST failed:", err);
    return NextResponse.json({ error: "Could not add investor." }, { status: 500 });
  }
}

export async function PATCH(req) {
  try {
    const { orgId, investorId, onboardingStatus, kycProviderStatus } = await req.json();
    if (!orgId || !investorId) return NextResponse.json({ error: "orgId and investorId are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, ["financial", "private_capital"]);
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await updateInvestorOnboarding({ orgId, investorId, onboardingStatus, kycProviderStatus, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ investor: serialize(result.investor) });
  } catch (err) {
    console.error("orgs/financial/investors PATCH failed:", err);
    return NextResponse.json({ error: "Could not update investor." }, { status: 500 });
  }
}
