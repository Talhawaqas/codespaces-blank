// app/api/orgs/private-capital/deals/[dealId]/term-sheets/route.js
// GET   ?orgId= -> list term sheet versions for a deal (most recent first)
// POST  { orgId, valuation?, ... } -> draft a new term sheet (v1)
// PATCH { orgId, termSheetId, updates } -> edit a DRAFT term sheet in place

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessFinancialEntities } from "../../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../../lib/industry-config.js";
import { createTermSheet, updateTermSheetDraft, listTermSheets } from "../../../../../../../lib/term-sheet.js";

function serialize(t) {
  return {
    id: t._id.toString(), dealId: t.dealId.toString(), version: t.version, supersedes: t.supersedes?.toString() || null,
    status: t.status, valuation: t.valuation, preMoney: t.preMoney, postMoney: t.postMoney, ownership: t.ownership,
    optionPool: t.optionPool, liquidationPreference: t.liquidationPreference, participation: t.participation,
    antiDilution: t.antiDilution, boardRights: t.boardRights, votingRights: t.votingRights, informationRights: t.informationRights,
    proRata: t.proRata, protectiveProvisions: t.protectiveProvisions, vesting: t.vesting, founderTerms: t.founderTerms,
    investorRights: t.investorRights, closingConditions: t.closingConditions,
  };
}

export async function GET(req, { params }) {
  try {
    const { dealId } = await params;
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "private_capital");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });
    if (!canAccessFinancialEntities(auth.membership)) return NextResponse.json({ error: "You don't have financial-entities access." }, { status: 403 });

    const termSheets = await listTermSheets(orgId, dealId);
    return NextResponse.json({ termSheets: termSheets.map(serialize) });
  } catch (err) {
    console.error("orgs/private-capital/deals/[dealId]/term-sheets GET failed:", err);
    return NextResponse.json({ error: "Could not fetch term sheets." }, { status: 500 });
  }
}

export async function POST(req, { params }) {
  try {
    const { dealId } = await params;
    const body = await req.json();
    const { orgId } = body;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "private_capital");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await createTermSheet({ ...body, dealId, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ termSheet: serialize(result.termSheet) });
  } catch (err) {
    console.error("orgs/private-capital/deals/[dealId]/term-sheets POST failed:", err);
    return NextResponse.json({ error: "Could not create term sheet." }, { status: 500 });
  }
}

export async function PATCH(req) {
  try {
    const { orgId, termSheetId, updates } = await req.json();
    if (!orgId || !termSheetId) return NextResponse.json({ error: "orgId and termSheetId are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "private_capital");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await updateTermSheetDraft({ orgId, termSheetId, updates: updates || {}, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ termSheet: serialize(result.termSheet) });
  } catch (err) {
    console.error("orgs/private-capital/deals/[dealId]/term-sheets PATCH failed:", err);
    return NextResponse.json({ error: "Could not update term sheet." }, { status: 500 });
  }
}
