// app/api/orgs/private-capital/portfolio-companies/[portfolioCompanyId]/value-creation/route.js
// GET   ?orgId=&status= -> list value creation plans for this company
// POST  { orgId, category, title, ... } -> create a plan
// PATCH { orgId, planId, status, actualResult? } -> update progress

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessFinancialEntities } from "../../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../../lib/industry-config.js";
import { createValueCreationPlan, updatePlanStatus, listValueCreationPlans } from "../../../../../../../lib/value-creation.js";

function serialize(p) {
  return { id: p._id.toString(), category: p.category, title: p.title, ownerEmail: p.ownerEmail, target: p.target, baseline: p.baseline, expectedResult: p.expectedResult, actualResult: p.actualResult, deadline: p.deadline, evidence: p.evidence, status: p.status };
}

export async function GET(req, { params }) {
  try {
    const { portfolioCompanyId } = await params;
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "private_capital");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });
    if (!canAccessFinancialEntities(auth.membership)) return NextResponse.json({ error: "You don't have financial-entities access." }, { status: 403 });

    const plans = await listValueCreationPlans(orgId, portfolioCompanyId, { status: searchParams.get("status") || undefined });
    return NextResponse.json({ plans: plans.map(serialize) });
  } catch (err) {
    console.error("orgs/private-capital/portfolio-companies/[id]/value-creation GET failed:", err);
    return NextResponse.json({ error: "Could not fetch value creation plans." }, { status: 500 });
  }
}

export async function POST(req, { params }) {
  try {
    const { portfolioCompanyId } = await params;
    const body = await req.json();
    const { orgId, category, title } = body;
    if (!orgId || !category || !title) return NextResponse.json({ error: "orgId, category, and title are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "private_capital");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await createValueCreationPlan({ ...body, portfolioCompanyId, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ plan: serialize(result.plan) });
  } catch (err) {
    console.error("orgs/private-capital/portfolio-companies/[id]/value-creation POST failed:", err);
    return NextResponse.json({ error: "Could not create value creation plan." }, { status: 500 });
  }
}

export async function PATCH(req) {
  try {
    const { orgId, planId, status, actualResult } = await req.json();
    if (!orgId || !planId || !status) return NextResponse.json({ error: "orgId, planId, and status are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "private_capital");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await updatePlanStatus({ orgId, planId, status, actualResult, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ plan: serialize(result.plan) });
  } catch (err) {
    console.error("orgs/private-capital/portfolio-companies/[id]/value-creation PATCH failed:", err);
    return NextResponse.json({ error: "Could not update value creation plan." }, { status: 500 });
  }
}
