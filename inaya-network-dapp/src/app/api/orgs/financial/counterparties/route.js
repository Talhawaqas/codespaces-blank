// app/api/orgs/financial/counterparties/route.js
// GET  ?orgId=&type=&onboardingStatus= -> list counterparties
// POST { orgId, type, name, riskRating? } -> add a counterparty (onboarding starts at REQUESTED)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessFinancialEntities } from "../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../lib/industry-config.js";
import { createCounterparty, listCounterparties } from "../../../../../lib/financial-counterparties.js";

function serialize(c) {
  return {
    id: c._id.toString(), type: c.type, name: c.name, onboardingStatus: c.onboardingStatus,
    riskRating: c.riskRating, exposure: c.exposure, renewalDate: c.renewalDate,
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

    const counterparties = await listCounterparties(orgId, { type: searchParams.get("type") || undefined, onboardingStatus: searchParams.get("onboardingStatus") || undefined });
    return NextResponse.json({ counterparties: counterparties.map(serialize) });
  } catch (err) {
    console.error("orgs/financial/counterparties GET failed:", err);
    return NextResponse.json({ error: "Could not fetch counterparties." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { orgId, type, name } = body;
    if (!orgId || !type || !name) return NextResponse.json({ error: "orgId, type, and name are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, ["financial", "private_capital"]);
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await createCounterparty({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ counterparty: serialize(result.counterparty) });
  } catch (err) {
    console.error("orgs/financial/counterparties POST failed:", err);
    return NextResponse.json({ error: "Could not add counterparty." }, { status: 500 });
  }
}
