// app/api/orgs/resilience/policies/[policyId]/route.js
//
// GET   /api/orgs/resilience/policies/:policyId?orgId=
// PATCH /api/orgs/resilience/policies/:policyId — body: { orgId, updates: {...} }

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../lib/orgs.js";
import { getPolicy, updatePolicy } from "../../../../../../lib/resilience-policy.js";

export async function GET(req, { params }) {
  try {
    const { policyId } = params;
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await getPolicy({ orgId, policyId });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/resilience/policies/[policyId] GET failed:", err);
    return NextResponse.json({ error: "Could not load the resilience policy." }, { status: 500 });
  }
}

export async function PATCH(req, { params }) {
  try {
    const { policyId } = params;
    const { orgId, updates } = await req.json();
    if (!orgId || !updates) return NextResponse.json({ error: "orgId and updates are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await updatePolicy({ orgId, policyId, updates, membership: auth.membership, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/resilience/policies/[policyId] PATCH failed:", err);
    return NextResponse.json({ error: "Could not update the resilience policy." }, { status: 500 });
  }
}
