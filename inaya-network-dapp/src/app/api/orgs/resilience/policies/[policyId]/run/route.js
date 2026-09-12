// app/api/orgs/resilience/policies/[policyId]/run/route.js
//
// POST /api/orgs/resilience/policies/:policyId/run — manually trigger a
// resilience test now. Runs the exact same orchestrator the daily cron
// runs (triggeredBy differs so the two are distinguishable in the
// evidence trail, per the SOW's "observable and independently
// distinguishable from production recovery operations" requirement).

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canManageOrg } from "../../../../../../../lib/orgs.js";
import { runResilienceTest } from "../../../../../../../lib/resilience-orchestrator.js";

export async function POST(req, { params }) {
  try {
    const { policyId } = params;
    const { orgId } = await req.json();
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!canManageOrg(auth.membership)) return NextResponse.json({ error: "Only the owner or an admin can trigger a resilience test." }, { status: 403 });

    const result = await runResilienceTest({ orgId, policyId, membership: auth.membership, actorEmail: auth.session.email, triggeredBy: "manual" });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/resilience/policies/[policyId]/run POST failed:", err);
    return NextResponse.json({ error: "Could not run the resilience test." }, { status: 500 });
  }
}
