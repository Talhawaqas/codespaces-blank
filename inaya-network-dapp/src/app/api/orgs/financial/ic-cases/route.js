// app/api/orgs/financial/ic-cases/route.js
// GET  ?orgId=&status=&fundId= -> list IC cases
// POST { orgId, opportunity, ... } -> create an IC case
// PATCH { orgId, caseId, action, note? } -> submit / startResearch / submitForComplianceReview /
//   submitForRiskReview / scheduleIC / resumeFromDeferral / execute / beginMonitoring / close / withdraw

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessFinancialEntities } from "../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../lib/industry-config.js";
import { createCase, transitionCase, listCases } from "../../../../../lib/investment-committee.js";

function serialize(c) {
  return {
    id: c._id.toString(), fundId: c.fundId?.toString() || null, opportunity: c.opportunity,
    thesisId: c.thesisId?.toString() || null, proposedPosition: c.proposedPosition, proposedAllocation: c.proposedAllocation,
    committeeMembers: c.committeeMembers, status: c.status, latestDecisionId: c.latestDecisionId?.toString() || null,
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

    const verticalCheck = await requireVertical(orgId, "financial");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });
    if (!canAccessFinancialEntities(auth.membership)) return NextResponse.json({ error: "You don't have financial-entities access." }, { status: 403 });

    const cases = await listCases(orgId, { status: searchParams.get("status") || undefined, fundId: searchParams.get("fundId") || undefined });
    return NextResponse.json({ cases: cases.map(serialize) });
  } catch (err) {
    console.error("orgs/financial/ic-cases GET failed:", err);
    return NextResponse.json({ error: "Could not fetch IC cases." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { orgId, opportunity } = body;
    if (!orgId || !opportunity) return NextResponse.json({ error: "orgId and opportunity are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "financial");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await createCase({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ case: serialize(result.case) });
  } catch (err) {
    console.error("orgs/financial/ic-cases POST failed:", err);
    return NextResponse.json({ error: "Could not create IC case." }, { status: 500 });
  }
}

export async function PATCH(req) {
  try {
    const { orgId, caseId, action, note } = await req.json();
    if (!orgId || !caseId || !action) return NextResponse.json({ error: "orgId, caseId, and action are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "financial");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await transitionCase({ orgId, caseId, action, note, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ case: serialize(result.case) });
  } catch (err) {
    console.error("orgs/financial/ic-cases PATCH failed:", err);
    return NextResponse.json({ error: "Could not update IC case." }, { status: 500 });
  }
}
