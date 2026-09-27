// POST /api/orgs/ml-studio/catalog/:catalogId/rules/:ruleId/run  { orgId }
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../../../lib/orgs.js";
import { runRule } from "../../../../../../../../../lib/mlStudio/dataQuality.js";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req, ctx) {
  try {
    const { ruleId } = await ctx.params;
    const { orgId } = await req.json();
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId); if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const r = await runRule({ orgId, membership: auth.membership, actorEmail: auth.session.email, ruleId });
    if (r.error) return NextResponse.json({ error: r.error }, { status: r.status || 400 });
    return NextResponse.json(r);
  } catch (err) { console.error("ml-studio rule run failed:", err?.message); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 }); }
}
