// app/api/orgs/critical-functions/[functionId]/continuity-plan/route.js
// GET  ?orgId= -> list continuity plans for this function
// POST { orgId, planText, testFrequencyMonths? } -> create a continuity plan

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../lib/orgs.js";
import { createContinuityPlan, listContinuityPlans } from "../../../../../../lib/business-continuity.js";

function serialize(p) {
  return { id: p._id.toString(), functionId: p.functionId.toString(), planText: p.planText, testFrequencyMonths: p.testFrequencyMonths, testLog: p.testLog };
}

export async function GET(req, { params }) {
  try {
    const { functionId } = await params;
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const plans = await listContinuityPlans(orgId, { functionId });
    return NextResponse.json({ plans: plans.map(serialize) });
  } catch (err) {
    console.error("orgs/critical-functions/[functionId]/continuity-plan GET failed:", err);
    return NextResponse.json({ error: "Could not fetch continuity plans." }, { status: 500 });
  }
}

export async function POST(req, { params }) {
  try {
    const { functionId } = await params;
    const body = await req.json();
    const { orgId, planText } = body;
    if (!orgId || !planText) return NextResponse.json({ error: "orgId and planText are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await createContinuityPlan({ ...body, functionId, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ plan: serialize(result.plan) });
  } catch (err) {
    console.error("orgs/critical-functions/[functionId]/continuity-plan POST failed:", err);
    return NextResponse.json({ error: "Could not create continuity plan." }, { status: 500 });
  }
}
