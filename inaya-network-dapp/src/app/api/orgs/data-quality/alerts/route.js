// app/api/orgs/data-quality/alerts/route.js
// GET ?orgId= -> data quality alerts, each raised from a real recorded signal, never invented

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { listDataQualityAlerts } from "../../../../../lib/data-quality.js";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await listDataQualityAlerts(orgId);
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/data-quality/alerts GET failed:", err);
    return NextResponse.json({ error: "Could not fetch data quality alerts." }, { status: 500 });
  }
}
