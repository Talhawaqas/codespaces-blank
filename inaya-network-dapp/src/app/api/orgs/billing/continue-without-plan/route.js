// app/api/orgs/billing/continue-without-plan/route.js
//
// POST /api/orgs/billing/continue-without-plan   { orgId }
//
// Owner/admin only, same requireManage gate as billing/checkout. Lets a
// newly-created org skip Stripe checkout entirely and continue on
// Starter-equivalent limits (2 users, 250GB, 5GB max file — see
// orgPlans.js's NO_PLAN_LIMITED) at no cost. Clears requiresPlanSelection
// so business/page.js's PlanSelectionGate stops blocking the workspace,
// and stamps noPlanConfirmedAt so getOrgPlan() returns NO_PLAN_LIMITED
// instead of treating this as a pre-existing/legacy-unlimited org — an
// org that actively declined billing is a different case from one that
// was simply never asked.

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, toObjectId } from "../../../../../lib/orgs.js";

export async function POST(req) {
  try {
    const { orgId } = await req.json();
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { orgs } = await getOrgCollections();
    const now = new Date().toISOString();
    const updated = await orgs.findOneAndUpdate(
      { _id: toObjectId(orgId) },
      { $set: { requiresPlanSelection: false, noPlanConfirmedAt: now, noPlanConfirmedByEmail: auth.session.email } },
      { returnDocument: "after" }
    );
    if (!updated) return NextResponse.json({ error: "Organization not found." }, { status: 404 });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("orgs/billing/continue-without-plan POST failed:", err);
    return NextResponse.json({ error: "Could not continue without a plan." }, { status: 500 });
  }
}
