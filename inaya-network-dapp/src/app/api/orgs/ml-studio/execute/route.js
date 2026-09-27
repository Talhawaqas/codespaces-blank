// POST /api/orgs/ml-studio/execute  { orgId, language: "python"|"node", code, relatedModelId?, allowNetwork?, timeoutMs? }
// Runs one code snippet in a fresh, isolated Vercel Sandbox. Owner/admin only -- see execution.js's header
// for the full safety posture (network denied by default, no server secrets passed in, rate-limited, audited).
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { runCodeSnippet, isSandboxConfigured } from "../../../../../lib/mlStudio/execution.js";

export const dynamic = "force-dynamic";
export const maxDuration = 150; // above execution.js's own 2-minute cap, so a real timeout is reported by the sandbox, not cut off by the platform first

export async function GET(req) {
  try {
    const url = new URL(req.url); const orgId = url.searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId); if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    return NextResponse.json({ configured: isSandboxConfigured() });
  } catch (err) { console.error("ml-studio sandbox status failed:", err?.message); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 }); }
}

export async function POST(req) {
  try {
    const { orgId, language, code, relatedModelId, allowNetwork, timeoutMs } = await req.json();
    if (!orgId || !language || !code) return NextResponse.json({ error: "orgId, language and code are required." }, { status: 400 });
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true }); if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const r = await runCodeSnippet({ orgId, membership: auth.membership, actorEmail: auth.session.email, language, code, relatedModelId: relatedModelId || null, allowNetwork: !!allowNetwork, timeoutMs });
    if (r.error) return NextResponse.json({ error: r.error }, { status: r.status || 400 });
    return NextResponse.json(r);
  } catch (err) { console.error("ml-studio sandbox execute failed:", err?.message); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 }); }
}
