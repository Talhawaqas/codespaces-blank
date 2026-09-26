// GET /api/portal/:slug/attachments/:id[?ideaId=]  -- customer download. Permission is re-checked against the ticket
// (owner or shared) and the attachment's visibility on every request; never inline; audited.
import { NextResponse } from "next/server";
import { ensureOrgIndexes } from "../../../../../../lib/orgs.js";
import { orgBySlug } from "../../../../../../lib/support/settings.js";
import { getPortalUser } from "../../../../../../lib/support/portalAuth.js";
import { getAttachmentForDownload, DOWNLOAD_HEADERS } from "../../../../../../lib/support/attachments.js";
import { getIdeaAttachment } from "../../../../../../lib/support/ideas.js";

export const dynamic = "force-dynamic";

export async function GET(req, ctx) {
  try {
    const { slug, id } = await ctx.params;
    await ensureOrgIndexes();
    const org = await orgBySlug(slug);
    if (!org) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const orgId = String(org.orgId);
    const user = await getPortalUser({ req, orgId });
    if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
    const ideaId = new URL(req.url).searchParams.get("ideaId");
    let f;
    if (ideaId) { f = await getIdeaAttachment({ orgId, ideaId, attachmentId: id, viewer: { kind: "customer", user } }); if (f) f = { ...f, contentType: "application/octet-stream" }; }
    else f = await getAttachmentForDownload({ orgId, attachmentId: id, viewer: { kind: "customer", user } });
    if (!f) return NextResponse.json({ error: "Attachment not found." }, { status: 404 });
    return new NextResponse(f.buffer, { status: 200, headers: DOWNLOAD_HEADERS(f.filename, f.contentType) });
  } catch (err) { console.error("portal download failed:", err?.message); return NextResponse.json({ error: "Something went wrong." }, { status: 500 }); }
}
