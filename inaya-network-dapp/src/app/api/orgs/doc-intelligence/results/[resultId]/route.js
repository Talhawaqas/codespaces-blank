// GET /api/orgs/doc-intelligence/results/:resultId?orgId=
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canManageOrg, canAccessDepartment } from "../../../../../../lib/orgs.js";
import { getResult, resultView } from "../../../../../../lib/docIntelligence/analyze.js";

export const dynamic = "force-dynamic";

export async function GET(req, ctx) {
  try {
    const { resultId } = await ctx.params;
    const url = new URL(req.url); const orgId = url.searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId); if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const result = await getResult({ orgId, resultId });
    if (!result) return NextResponse.json({ error: "Result not found." }, { status: 404 });
    if (result.departmentId ? !canAccessDepartment(auth.membership, result.departmentId) : !canManageOrg(auth.membership)) return NextResponse.json({ error: "You don't have access to this result." }, { status: 403 });
    return NextResponse.json({ result: resultView(result, { full: true }) });
  } catch (err) { console.error("doc-intelligence result read failed:", err?.message); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 }); }
}
