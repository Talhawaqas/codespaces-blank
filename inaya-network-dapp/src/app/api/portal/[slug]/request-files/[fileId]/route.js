// GET /api/portal/:slug/request-files/:fileId?requestId=  -- a customer downloads a file of a request addressed to them (their own upload, or a file staff released to them).
// Permission is re-checked on every request; the storage key comes from our own record; never inline; audited.
import { NextResponse } from "next/server";
import { ensureOrgIndexes } from "../../../../../../lib/orgs.js";
import { orgBySlug } from "../../../../../../lib/support/settings.js";
import { getPortalUser } from "../../../../../../lib/support/portalAuth.js";
import { DOWNLOAD_HEADERS } from "../../../../../../lib/support/attachments.js";
import * as PR from "../../../../../../lib/support/portalRequests.js";
export const dynamic = "force-dynamic";

export async function GET(req, ctx) {
  try {
    const { slug, fileId } = await ctx.params; await ensureOrgIndexes(); const org = await orgBySlug(slug); if (!org) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const orgId = String(org.orgId); const user = await getPortalUser({ req, orgId }); if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
    const f = await PR.getFileForDownload({ orgId, requestId: new URL(req.url).searchParams.get("requestId"), fileId, viewer: { kind: "customer", user } });
    if (!f) return NextResponse.json({ error: "File not found." }, { status: 404 });
    return new NextResponse(f.buffer, { status: 200, headers: DOWNLOAD_HEADERS(f.filename, f.contentType) });
  } catch (err) { console.error("portal request download failed:", err?.message); return NextResponse.json({ error: "Something went wrong." }, { status: 500 }); }
}
