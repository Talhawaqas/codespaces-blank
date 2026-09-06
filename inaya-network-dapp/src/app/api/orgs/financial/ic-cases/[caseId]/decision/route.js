// app/api/orgs/financial/ic-cases/[caseId]/decision/route.js
// GET   ?orgId= -> full decision-version history for this case (most recent first)
// POST  { orgId, outcome, conditions?, dissentingViews?, finalResolution? } -> record the IC vote
//   (outcome: approve | approveWithConditions | reject | defer) -- only legal from IC_SCHEDULED
// PATCH { orgId, conditions?, dissentingViews?, finalResolution? } -> amend the latest decision,
//   creating a NEW version -- the original decision row is never mutated

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../../lib/industry-config.js";
import { recordDecision, amendDecision, getCaseDecisionHistory } from "../../../../../../../lib/investment-committee.js";

function serializeDecision(d) {
  return {
    id: d._id.toString(), version: d.version, supersedes: d.supersedes?.toString() || null,
    outcome: d.outcome, conditions: d.conditions, dissentingViews: d.dissentingViews,
    finalResolution: d.finalResolution, decidedByEmail: d.decidedByEmail, decidedAt: d.decidedAt,
  };
}

export async function GET(req, { params }) {
  try {
    const { caseId } = await params;
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "financial");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const history = await getCaseDecisionHistory(orgId, caseId);
    return NextResponse.json({ decisions: history.map(serializeDecision) });
  } catch (err) {
    console.error("orgs/financial/ic-cases/[caseId]/decision GET failed:", err);
    return NextResponse.json({ error: "Could not fetch decision history." }, { status: 500 });
  }
}

export async function POST(req, { params }) {
  try {
    const { caseId } = await params;
    const body = await req.json();
    const { orgId, outcome } = body;
    if (!orgId || !outcome) return NextResponse.json({ error: "orgId and outcome are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "financial");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await recordDecision({ orgId, caseId, outcome, conditions: body.conditions, dissentingViews: body.dissentingViews, finalResolution: body.finalResolution, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ decision: serializeDecision(result.decision), caseStatus: result.case.status });
  } catch (err) {
    console.error("orgs/financial/ic-cases/[caseId]/decision POST failed:", err);
    return NextResponse.json({ error: "Could not record IC decision." }, { status: 500 });
  }
}

export async function PATCH(req, { params }) {
  try {
    const { caseId } = await params;
    const body = await req.json();
    const { orgId } = body;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "financial");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await amendDecision({ orgId, caseId, conditions: body.conditions, dissentingViews: body.dissentingViews, finalResolution: body.finalResolution, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ decision: serializeDecision(result.decision) });
  } catch (err) {
    console.error("orgs/financial/ic-cases/[caseId]/decision PATCH failed:", err);
    return NextResponse.json({ error: "Could not amend IC decision." }, { status: 500 });
  }
}
