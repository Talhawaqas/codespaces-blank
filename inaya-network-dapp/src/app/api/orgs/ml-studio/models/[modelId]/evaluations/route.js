// GET  /api/orgs/ml-studio/models/:modelId/evaluations?orgId=
// POST /api/orgs/ml-studio/models/:modelId/evaluations  { orgId, metrics: {...}, notes? }  -- owner/admin only
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { listEvaluations, recordEvaluation } from "../../../../../../../lib/mlStudio/evaluations.js";

export const dynamic = "force-dynamic";

export async function GET(req, ctx) {
  try {
    const { modelId } = await ctx.params;
    const url = new URL(req.url); const orgId = url.searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId); if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const r = await listEvaluations({ orgId, modelId, limit: Number(url.searchParams.get("limit") || 20) });
    return NextResponse.json(r);
  } catch (err) { console.error("ml-studio evaluations list failed:", err?.message); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 }); }
}

export async function POST(req, ctx) {
  try {
    const { modelId } = await ctx.params;
    const { orgId, metrics, notes } = await req.json();
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true }); if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const r = await recordEvaluation({ orgId, membership: auth.membership, actorEmail: auth.session.email, modelId, metrics, notes });
    if (r.error) return NextResponse.json({ error: r.error }, { status: r.status || 400 });
    return NextResponse.json(r);
  } catch (err) { console.error("ml-studio evaluation record failed:", err?.message); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 }); }
}
