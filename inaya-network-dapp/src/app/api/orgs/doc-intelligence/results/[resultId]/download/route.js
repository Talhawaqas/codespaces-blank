// GET /api/orgs/doc-intelligence/results/:resultId/download?orgId=
// Serves the ORIGINAL document that was analyzed, not the extracted fields (see the parent route for that).
// Always a forced download (never rendered inline) with the same hardened headers every other file-download
// route in this codebase uses -- a stored SVG/HTML masquerading as a "document" is never served in a way a
// browser would execute, whatever its declared content type.
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canManageOrg, canAccessDepartment } from "../../../../../../../lib/orgs.js";
import { getResult, downloadResultDocument } from "../../../../../../../lib/docIntelligence/analyze.js";
import { DOWNLOAD_HEADERS } from "../../../../../../../lib/support/attachments.js";

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
    const f = await downloadResultDocument({ orgId, resultId });
    if (f.error) return NextResponse.json({ error: f.error }, { status: f.status || 404 });
    return new NextResponse(f.buffer, { status: 200, headers: DOWNLOAD_HEADERS(f.filename, f.contentType) });
  } catch (err) { console.error("doc-intelligence result download failed:", err?.message); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 }); }
}
