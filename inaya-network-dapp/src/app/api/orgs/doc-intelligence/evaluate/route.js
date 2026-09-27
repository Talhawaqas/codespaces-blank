// GET  /api/orgs/doc-intelligence/evaluate?orgId=&analyzerKey=       -- list past evaluation runs (owner/admin only)
// POST /api/orgs/doc-intelligence/evaluate  { orgId, analyzerKey, fieldSchema?, samples }
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { runEvaluation, listEvaluations } from "../../../../../lib/docIntelligence/evaluate.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    const url = new URL(req.url); const orgId = url.searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true }); if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const evaluations = await listEvaluations({ orgId, analyzerKey: url.searchParams.get("analyzerKey") || null });
    return NextResponse.json({ evaluations });
  } catch (err) { console.error("doc-intelligence evaluations list failed:", err?.message); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 }); }
}

export async function POST(req) {
  try {
    const { orgId, analyzerKey, fieldSchema, samples } = await req.json();
    if (!orgId || !analyzerKey) return NextResponse.json({ error: "orgId and analyzerKey are required." }, { status: 400 });
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true }); if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const r = await runEvaluation({ orgId, analyzerKey, fieldSchema, samples, actorEmail: auth.session.email });
    if (r.error) return NextResponse.json({ error: r.error }, { status: r.status || 400 });
    return NextResponse.json(r);
  } catch (err) { console.error("doc-intelligence evaluation run failed:", err?.message); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 }); }
}
