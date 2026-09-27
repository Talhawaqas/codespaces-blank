// GET /api/orgs/doc-intelligence/review?orgId=&status=OPEN  -- owner/admin only, same as bookkeeper's review queue
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { listQueue } from "../../../../../lib/docIntelligence/review.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    const url = new URL(req.url); const orgId = url.searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true }); if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const r = await listQueue({ orgId, status: url.searchParams.get("status") || "OPEN", limit: Number(url.searchParams.get("limit") || 50), skip: Number(url.searchParams.get("skip") || 0) });
    return NextResponse.json(r);
  } catch (err) { console.error("doc-intelligence review queue failed:", err?.message); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 }); }
}
