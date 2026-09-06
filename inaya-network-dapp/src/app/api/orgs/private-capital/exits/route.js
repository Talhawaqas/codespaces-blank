// app/api/orgs/private-capital/exits/route.js
// GET   ?orgId=&portfolioCompanyId=&status= -> list exits
// POST  { orgId, portfolioCompanyId, exitType? } -> start an exit process (status: READINESS)
// PATCH { orgId, exitId, action, note? } -> beginOutreach / beginDiligence / receiveBids / negotiate / close

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessFinancialEntities } from "../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../lib/industry-config.js";
import { createExit, transitionExit, listExits } from "../../../../../lib/exit-management.js";

function serialize(e) {
  return { id: e._id.toString(), portfolioCompanyId: e.portfolioCompanyId.toString(), exitType: e.exitType, bids: e.bids, icDecisionId: e.icDecisionId?.toString() || null, distributionAmount: e.distributionAmount, status: e.status };
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

    const exits = await listExits(orgId, { portfolioCompanyId: searchParams.get("portfolioCompanyId") || undefined, status: searchParams.get("status") || undefined });
    return NextResponse.json({ exits: exits.map(serialize) });
  } catch (err) {
    console.error("orgs/private-capital/exits GET failed:", err);
    return NextResponse.json({ error: "Could not fetch exits." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { orgId, portfolioCompanyId } = body;
    if (!orgId || !portfolioCompanyId) return NextResponse.json({ error: "orgId and portfolioCompanyId are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "private_capital");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await createExit({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ exit: serialize(result.exit) });
  } catch (err) {
    console.error("orgs/private-capital/exits POST failed:", err);
    return NextResponse.json({ error: "Could not create exit." }, { status: 500 });
  }
}

export async function PATCH(req) {
  try {
    const { orgId, exitId, action, note } = await req.json();
    if (!orgId || !exitId || !action) return NextResponse.json({ error: "orgId, exitId, and action are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "private_capital");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await transitionExit({ orgId, exitId, action, note, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ exit: serialize(result.exit) });
  } catch (err) {
    console.error("orgs/private-capital/exits PATCH failed:", err);
    return NextResponse.json({ error: "Could not update exit." }, { status: 500 });
  }
}
