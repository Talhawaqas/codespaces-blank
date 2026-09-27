// GET  /api/orgs/doc-intelligence/analyzers?orgId=&status=   -- list built-in + custom analyzers
// POST /api/orgs/doc-intelligence/analyzers                  -- create a custom analyzer (owner/admin only)
//   body: { orgId, name, description?, method: EXTRACT|CLASSIFY|GENERATE, fieldSchema?, classificationLabels? }
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { listAnalyzers, createAnalyzer } from "../../../../../lib/docIntelligence/analyzers.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    const url = new URL(req.url); const orgId = url.searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId); if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const analyzers = await listAnalyzers({ orgId, status: url.searchParams.get("status") || null });
    return NextResponse.json({ analyzers });
  } catch (err) { console.error("doc-intelligence analyzers list failed:", err?.message); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 }); }
}

export async function POST(req) {
  try {
    const body = await req.json(); const { orgId, name, description, method, fieldSchema, classificationLabels } = body || {};
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true }); if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const r = await createAnalyzer({ orgId, name, description, method, fieldSchema, classificationLabels, actorEmail: auth.session.email });
    if (r.error) return NextResponse.json({ error: r.error }, { status: r.status || 400 });
    return NextResponse.json(r);
  } catch (err) { console.error("doc-intelligence analyzer create failed:", err?.message); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 }); }
}
