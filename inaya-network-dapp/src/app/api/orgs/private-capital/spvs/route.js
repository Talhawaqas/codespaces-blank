// app/api/orgs/private-capital/spvs/route.js
// GET  ?orgId= -> list SPVs
// POST { orgId, name, underlyingAsset, managementFeeBps?, carryBps? } -> register an SPV
//   (creates a real financialFunds document with structureType:"spv" -- see spv-management.js)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessFinancialEntities } from "../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../lib/industry-config.js";
import { createSpv, listSpvs } from "../../../../../lib/spv-management.js";

function serialize(s) {
  return { id: s._id.toString(), fundId: s.fundId.toString(), underlyingAsset: s.underlyingAsset, managementFeeBps: s.managementFeeBps, carryBps: s.carryBps, expenses: s.expenses, legalDocumentIds: (s.legalDocumentIds || []).map((id) => id.toString()) };
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

    const spvs = await listSpvs(orgId);
    return NextResponse.json({ spvs: spvs.map(serialize) });
  } catch (err) {
    console.error("orgs/private-capital/spvs GET failed:", err);
    return NextResponse.json({ error: "Could not fetch SPVs." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { orgId, name, underlyingAsset } = body;
    if (!orgId || !name || !underlyingAsset) return NextResponse.json({ error: "orgId, name, and underlyingAsset are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "private_capital");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await createSpv({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ spv: serialize(result.spv), fund: { id: result.fund._id.toString(), legalName: result.fund.legalName } });
  } catch (err) {
    console.error("orgs/private-capital/spvs POST failed:", err);
    return NextResponse.json({ error: "Could not register SPV." }, { status: 500 });
  }
}
