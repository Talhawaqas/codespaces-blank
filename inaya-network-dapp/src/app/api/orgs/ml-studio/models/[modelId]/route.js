// GET   /api/orgs/ml-studio/models/:modelId?orgId=
// PATCH /api/orgs/ml-studio/models/:modelId  { orgId, status }  -- lifecycle transition, owner/admin only
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../lib/orgs.js";
import { getModel, modelView, setModelStatus } from "../../../../../../lib/mlStudio/models.js";

export const dynamic = "force-dynamic";

export async function GET(req, ctx) {
  try {
    const { modelId } = await ctx.params;
    const url = new URL(req.url); const orgId = url.searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId); if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const m = await getModel({ orgId, modelId });
    if (!m) return NextResponse.json({ error: "Model version not found." }, { status: 404 });
    return NextResponse.json({ model: modelView(m) });
  } catch (err) { console.error("ml-studio model read failed:", err?.message); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 }); }
}

export async function PATCH(req, ctx) {
  try {
    const { modelId } = await ctx.params;
    const { orgId, status } = await req.json();
    if (!orgId || !status) return NextResponse.json({ error: "orgId and status are required." }, { status: 400 });
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true }); if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const r = await setModelStatus({ orgId, membership: auth.membership, actorEmail: auth.session.email, modelId, status });
    if (r.error) return NextResponse.json({ error: r.error }, { status: r.status || 400 });
    return NextResponse.json(r);
  } catch (err) { console.error("ml-studio model status change failed:", err?.message); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 }); }
}
