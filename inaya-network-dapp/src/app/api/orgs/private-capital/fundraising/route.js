// app/api/orgs/private-capital/fundraising/route.js
// GET   ?orgId=&fundId=&stage= -> list LP fundraising prospects
// POST  { orgId, fundId, legalName, ... } -> create a prospect (stage: IDENTIFIED)
// PATCH { orgId, prospectId, action, note? } -> advance / pass / reopen

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessFinancialEntities } from "../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../lib/industry-config.js";
import { createFundraisingProspect, transitionProspect, listFundraisingProspects } from "../../../../../lib/fundraising.js";

function serialize(p) {
  return { id: p._id.toString(), fundId: p.fundId.toString(), legalName: p.legalName, targetCommitment: p.targetCommitment, source: p.source, communications: p.communications, convertedInvestorId: p.convertedInvestorId?.toString() || null, stage: p.stage };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const fundId = searchParams.get("fundId");
    if (!orgId || !fundId) return NextResponse.json({ error: "orgId and fundId are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "private_capital");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });
    if (!canAccessFinancialEntities(auth.membership)) return NextResponse.json({ error: "You don't have financial-entities access." }, { status: 403 });

    const prospects = await listFundraisingProspects(orgId, fundId, { stage: searchParams.get("stage") || undefined });
    return NextResponse.json({ prospects: prospects.map(serialize) });
  } catch (err) {
    console.error("orgs/private-capital/fundraising GET failed:", err);
    return NextResponse.json({ error: "Could not fetch fundraising prospects." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { orgId, fundId, legalName } = body;
    if (!orgId || !fundId || !legalName) return NextResponse.json({ error: "orgId, fundId, and legalName are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "private_capital");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await createFundraisingProspect({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ prospect: serialize(result.prospect) });
  } catch (err) {
    console.error("orgs/private-capital/fundraising POST failed:", err);
    return NextResponse.json({ error: "Could not create fundraising prospect." }, { status: 500 });
  }
}

export async function PATCH(req) {
  try {
    const { orgId, prospectId, action, note } = await req.json();
    if (!orgId || !prospectId || !action) return NextResponse.json({ error: "orgId, prospectId, and action are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "private_capital");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await transitionProspect({ orgId, prospectId, action, note, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ prospect: serialize(result.prospect) });
  } catch (err) {
    console.error("orgs/private-capital/fundraising PATCH failed:", err);
    return NextResponse.json({ error: "Could not update fundraising prospect." }, { status: 500 });
  }
}
