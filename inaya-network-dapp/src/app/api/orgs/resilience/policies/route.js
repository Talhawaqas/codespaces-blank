// app/api/orgs/resilience/policies/route.js
//
// POST /api/orgs/resilience/policies — body: { orgId, name, requiredRTOMinutes,
//      requiredRPOMinutes, criticalAssetCategories, testFrequency }
// GET  /api/orgs/resilience/policies?orgId= — list

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { createPolicy, listPolicies } from "../../../../../lib/resilience-policy.js";

export async function POST(req) {
  try {
    const { orgId, name, requiredRTOMinutes, requiredRPOMinutes, criticalAssetCategories, testFrequency } = await req.json();
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await createPolicy({ orgId, name, requiredRTOMinutes, requiredRPOMinutes, criticalAssetCategories, testFrequency, membership: auth.membership, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/resilience/policies POST failed:", err);
    return NextResponse.json({ error: "Could not create the resilience policy." }, { status: 500 });
  }
}

export async function GET(req) {
  try {
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await listPolicies({ orgId });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/resilience/policies GET failed:", err);
    return NextResponse.json({ error: "Could not list resilience policies." }, { status: 500 });
  }
}
