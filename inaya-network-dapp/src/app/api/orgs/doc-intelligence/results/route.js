// GET /api/orgs/doc-intelligence/results?orgId=&analyzerKey=&status=&limit=&skip=
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canManageOrg } from "../../../../../lib/orgs.js";
import { listResults } from "../../../../../lib/docIntelligence/analyze.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    const url = new URL(req.url); const orgId = url.searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId); if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    // Owner/admin see every result (including the org-manager-only, no-department ones); a plain member sees
    // only results in departments they're assigned to -- same visibility rule as canAccessDepartment().
    const departmentIds = canManageOrg(auth.membership) ? null : (auth.membership.departmentIds || []).map((d) => String(d));
    const r = await listResults({ orgId, departmentIds, analyzerKey: url.searchParams.get("analyzerKey") || null, status: url.searchParams.get("status") || null, limit: Number(url.searchParams.get("limit") || 50), skip: Number(url.searchParams.get("skip") || 0) });
    return NextResponse.json(r);
  } catch (err) { console.error("doc-intelligence results list failed:", err?.message); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 }); }
}
