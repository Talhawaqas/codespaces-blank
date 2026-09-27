// GET  /api/orgs/ml-studio/catalog/:catalogId/rules?orgId=
// POST /api/orgs/ml-studio/catalog/:catalogId/rules  { orgId, type, column?, params? }  -- owner/admin only
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { createRule, listRules } from "../../../../../../../lib/mlStudio/dataQuality.js";

export const dynamic = "force-dynamic";

export async function GET(req, ctx) {
  try {
    const { catalogId } = await ctx.params;
    const url = new URL(req.url); const orgId = url.searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId); if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const r = await listRules({ orgId, catalogId });
    return NextResponse.json(r);
  } catch (err) { console.error("ml-studio rules list failed:", err?.message); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 }); }
}

export async function POST(req, ctx) {
  try {
    const { catalogId } = await ctx.params;
    const { orgId, type, column, params } = await req.json();
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true }); if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const r = await createRule({ orgId, membership: auth.membership, actorEmail: auth.session.email, catalogId, type, column, params });
    if (r.error) return NextResponse.json({ error: r.error }, { status: r.status || 400 });
    return NextResponse.json(r);
  } catch (err) { console.error("ml-studio rule create failed:", err?.message); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 }); }
}
