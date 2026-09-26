// GET /api/orgs/support/attachments/:id?orgId=  -- agent download. Permission is re-checked against the ticket
// and the attachment's visibility on EVERY request; the id is the only input (never a path or key); the access is
// written to the audit chain; the file is always served as a download, never rendered.
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../lib/orgs.js";
import { getAttachmentForDownload, DOWNLOAD_HEADERS } from "../../../../../../lib/support/attachments.js";

export const dynamic = "force-dynamic";

export async function GET(req, ctx) {
  try {
    const orgId = new URL(req.url).searchParams.get("orgId");
    const { id } = await ctx.params;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const f = await getAttachmentForDownload({ orgId, attachmentId: id, viewer: { kind: "agent", membership: auth.membership, email: auth.session.email } });
    if (!f) return NextResponse.json({ error: "Attachment not found." }, { status: 404 });
    return new NextResponse(f.buffer, { status: 200, headers: DOWNLOAD_HEADERS(f.filename, f.contentType) });
  } catch (err) { console.error("support attachment download failed:", err?.message); return NextResponse.json({ error: "Something went wrong." }, { status: 500 }); }
}
