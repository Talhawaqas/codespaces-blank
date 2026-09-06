// app/api/orgs/financial/funds/route.js
// GET  ?orgId= -> list funds visible to the caller (assignment-scoped, see document-permissions.js)
// POST { orgId, legalName, ... } -> register a fund (creator is auto-assigned to its team)
// PATCH { orgId, fundId, status } -> update fund status

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../lib/industry-config.js";
import { getAccessibleScope } from "../../../../../lib/document-permissions.js";
import { createFund, updateFundStatus } from "../../../../../lib/fund-registry.js";

function serialize(f) {
  return {
    id: f._id.toString(), legalName: f.legalName, shortName: f.shortName, fundType: f.fundType,
    structureType: f.structureType, domicile: f.domicile, jurisdiction: f.jurisdiction,
    baseCurrency: f.baseCurrency, status: f.status, strategy: f.strategy,
    administrator: f.administrator, custodian: f.custodian, primeBroker: f.primeBroker,
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

    const scope = await getAccessibleScope({ orgId, membership: auth.membership, email: auth.session.email });
    return NextResponse.json({ funds: scope.visibleFunds.map(serialize) });
  } catch (err) {
    console.error("orgs/financial/funds GET failed:", err);
    return NextResponse.json({ error: "Could not fetch funds." }, { status: 500 });
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

    const result = await createFund({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ fund: serialize(result.fund) });
  } catch (err) {
    console.error("orgs/financial/funds POST failed:", err);
    return NextResponse.json({ error: "Could not register fund." }, { status: 500 });
  }
}

export async function PATCH(req) {
  try {
    const { orgId, fundId, status } = await req.json();
    if (!orgId || !fundId || !status) return NextResponse.json({ error: "orgId, fundId, and status are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, ["financial", "private_capital"]);
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await updateFundStatus({ orgId, fundId, status, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ fund: serialize(result.fund) });
  } catch (err) {
    console.error("orgs/financial/funds PATCH failed:", err);
    return NextResponse.json({ error: "Could not update fund." }, { status: 500 });
  }
}
