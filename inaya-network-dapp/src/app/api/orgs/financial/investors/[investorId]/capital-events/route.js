// app/api/orgs/financial/investors/[investorId]/capital-events/route.js
// GET  ?orgId=&fundId= -> capital account summary (events + totals) for one investor/fund pair
// POST { orgId, fundId, type, amount, currency?, eventDate? } -> record a capital event

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessFinancialEntities } from "../../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../../lib/industry-config.js";
import { recordCapitalEvent, getCapitalAccountSummary } from "../../../../../../../lib/financial-investors.js";

function serializeEvent(e) {
  return { id: e._id.toString(), type: e.type, amount: e.amount, currency: e.currency, eventDate: e.eventDate };
}

export async function GET(req, { params }) {
  try {
    const { investorId } = await params;
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const fundId = searchParams.get("fundId");
    if (!orgId || !fundId) return NextResponse.json({ error: "orgId and fundId are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, ["financial", "private_capital"]);
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });
    if (!canAccessFinancialEntities(auth.membership)) return NextResponse.json({ error: "You don't have financial-entities access." }, { status: 403 });

    const summary = await getCapitalAccountSummary(orgId, investorId, fundId);
    return NextResponse.json({ events: summary.events.map(serializeEvent), totals: summary.totals, netAssetContributed: summary.netAssetContributed });
  } catch (err) {
    console.error("orgs/financial/investors/[investorId]/capital-events GET failed:", err);
    return NextResponse.json({ error: "Could not fetch capital account." }, { status: 500 });
  }
}

export async function POST(req, { params }) {
  try {
    const { investorId } = await params;
    const body = await req.json();
    const { orgId, fundId, type, amount } = body;
    if (!orgId || !fundId || !type || !amount) return NextResponse.json({ error: "orgId, fundId, type, and amount are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, ["financial", "private_capital"]);
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await recordCapitalEvent({ orgId, investorId, fundId, type, amount, currency: body.currency, eventDate: body.eventDate, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ capitalEvent: serializeEvent(result.capitalEvent) });
  } catch (err) {
    console.error("orgs/financial/investors/[investorId]/capital-events POST failed:", err);
    return NextResponse.json({ error: "Could not record capital event." }, { status: 500 });
  }
}
