// GET /api/orgs/ml-studio/models/:modelId/download?orgId=
// Serves the registered model artifact. Always a forced download (never rendered inline), same
// hardened headers as every other file-download route in this codebase.
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { getModel, downloadArtifact } from "../../../../../../../lib/mlStudio/models.js";
import { DOWNLOAD_HEADERS } from "../../../../../../../lib/support/attachments.js";

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
    const f = await downloadArtifact({ orgId, modelId });
    if (f.error) return NextResponse.json({ error: f.error }, { status: f.status || 404 });
    return new NextResponse(f.buffer, { status: 200, headers: DOWNLOAD_HEADERS(f.filename, f.contentType) });
  } catch (err) { console.error("ml-studio artifact download failed:", err?.message); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 }); }
}
