// app/api/orgs/dashboard-trends/route.js
// GET ?orgId= -> { pendingApprovals: [{day, count}]x7 | null }

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../lib/orgs.js";
import { getPendingApprovalsTrend } from "../../../../lib/dashboard-trends.js";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const pendingApprovals = await getPendingApprovalsTrend(orgId);
    return NextResponse.json({ pendingApprovals });
  } catch (err) {
    console.error("orgs/dashboard-trends GET failed:", err);
    return NextResponse.json({ error: "Could not fetch dashboard trends." }, { status: 500 });
  }
}
