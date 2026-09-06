// app/api/orgs/private-capital/deals/[dealId]/scorecards/route.js
// GET  ?orgId= -> list scorecards for a deal (most recent first)
// POST { orgId, scores, rationale? } -> submit a NEW versioned scorecard (never overwrites a prior one)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessFinancialEntities } from "../../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../../lib/industry-config.js";
import { submitScorecard, listScorecards } from "../../../../../../../lib/deal-pipeline.js";

function serialize(s) {
  return { id: s._id.toString(), version: s.version, scores: s.scores, rationale: s.rationale, weightedScore: s.weightedScore, evaluatorEmail: s.evaluatorEmail, evaluatedAt: s.evaluatedAt };
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

    const scorecards = await listScorecards(orgId, dealId);
    return NextResponse.json({ scorecards: scorecards.map(serialize) });
  } catch (err) {
    console.error("orgs/private-capital/deals/[dealId]/scorecards GET failed:", err);
    return NextResponse.json({ error: "Could not fetch scorecards." }, { status: 500 });
  }
}

export async function POST(req, { params }) {
  try {
    const { dealId } = await params;
    const body = await req.json();
    const { orgId, scores } = body;
    if (!orgId || !scores) return NextResponse.json({ error: "orgId and scores are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "private_capital");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await submitScorecard({ orgId, dealId, scores, rationale: body.rationale, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ scorecard: serialize(result.scorecard) });
  } catch (err) {
    console.error("orgs/private-capital/deals/[dealId]/scorecards POST failed:", err);
    return NextResponse.json({ error: "Could not submit scorecard." }, { status: 500 });
  }
}
