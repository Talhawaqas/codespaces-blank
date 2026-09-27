// PATCH /api/orgs/doc-intelligence/analyzers/:analyzerId   { orgId, status }  -- lifecycle transition (owner/admin only)
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../lib/orgs.js";
import { setAnalyzerStatus } from "../../../../../../lib/docIntelligence/analyzers.js";

export const dynamic = "force-dynamic";

export async function PATCH(req, ctx) {
  try {
    const { analyzerId } = await ctx.params;
    const { orgId, status } = await req.json();
    if (!orgId || !status) return NextResponse.json({ error: "orgId and status are required." }, { status: 400 });
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true }); if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const r = await setAnalyzerStatus({ orgId, analyzerId, status, actorEmail: auth.session.email });
    if (r.error) return NextResponse.json({ error: r.error }, { status: r.status || 400 });
    return NextResponse.json(r);
  } catch (err) { console.error("doc-intelligence analyzer status change failed:", err?.message); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 }); }
}
