// app/api/orgs/data-quality/route.js
// GET ?orgId= -> data quality scores for every configured integration (unknown, never fabricated, for anything unsynced)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../lib/orgs.js";
import { computeOrgDataQualityScores } from "../../../../lib/data-quality.js";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await computeOrgDataQualityScores(orgId);
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/data-quality GET failed:", err);
    return NextResponse.json({ error: "Could not compute data quality scores." }, { status: 500 });
  }
}
