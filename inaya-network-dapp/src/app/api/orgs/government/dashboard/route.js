// app/api/orgs/government/dashboard/route.js
// GET ?orgId= -> operations + security readiness dashboard (Phase 2 KPIs + Phase 4 readiness)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../lib/industry-config.js";
import { canAccessGovernment } from "../../../../../lib/orgGates.js";
import { getGovernmentDashboard } from "../../../../../lib/government-dashboard.js";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "government");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });
    if (!canAccessGovernment(auth.membership)) return NextResponse.json({ error: "You don't have Government OS access." }, { status: 403 });

    const dashboard = await getGovernmentDashboard(orgId);
    return NextResponse.json(dashboard);
  } catch (err) {
    console.error("orgs/government/dashboard GET failed:", err);
    return NextResponse.json({ error: "Could not fetch the dashboard." }, { status: 500 });
  }
}
