// app/api/orgs/executive/compliance-dashboard/route.js
// GET ?orgId= -> the Executive Compliance Dashboard

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { getExecutiveComplianceDashboard } from "../../../../../lib/executive-compliance-dashboard.js";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await getExecutiveComplianceDashboard(orgId);
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/executive/compliance-dashboard GET failed:", err);
    return NextResponse.json({ error: "Could not compute the compliance dashboard." }, { status: 500 });
  }
}
