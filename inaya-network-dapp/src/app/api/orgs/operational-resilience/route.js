// app/api/orgs/operational-resilience/route.js
// GET ?orgId= -> the operational resilience dashboard (§70)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../lib/orgs.js";
import { getOperationalResilienceDashboard } from "../../../../lib/operational-resilience.js";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const dashboard = await getOperationalResilienceDashboard(orgId);
    return NextResponse.json(dashboard);
  } catch (err) {
    console.error("orgs/operational-resilience GET failed:", err);
    return NextResponse.json({ error: "Could not fetch operational resilience dashboard." }, { status: 500 });
  }
}
