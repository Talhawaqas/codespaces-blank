// GET /api/orgs/ml-studio/catalog/:catalogId/runs?orgId=  -- data quality run history
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { listRuns } from "../../../../../../../lib/mlStudio/dataQuality.js";

export const dynamic = "force-dynamic";

export async function GET(req, ctx) {
  try {
    const { catalogId } = await ctx.params;
    const url = new URL(req.url); const orgId = url.searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId); if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const r = await listRuns({ orgId, catalogId, limit: Number(url.searchParams.get("limit") || 20) });
    return NextResponse.json(r);
  } catch (err) { console.error("ml-studio runs list failed:", err?.message); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 }); }
}
