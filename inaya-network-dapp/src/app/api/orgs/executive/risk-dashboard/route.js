// app/api/orgs/executive/risk-dashboard/route.js
// GET ?orgId= -> the Executive Risk Dashboard

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { getExecutiveRiskDashboard } from "../../../../../lib/executive-risk-dashboard.js";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await getExecutiveRiskDashboard(orgId);
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/executive/risk-dashboard GET failed:", err);
    return NextResponse.json({ error: "Could not compute the risk dashboard." }, { status: 500 });
  }
}
