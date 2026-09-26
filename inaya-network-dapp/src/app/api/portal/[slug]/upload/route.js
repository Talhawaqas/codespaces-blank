// POST /api/portal/:slug/upload?ticketId=&messageId=   or   ?ideaId=     (multipart/form-data, field "file")
// Customer attachment upload. The customer must be able to see the ticket (owner or shared) or own the idea.
import { NextResponse } from "next/server";
import { ensureOrgIndexes } from "../../../../../lib/orgs.js";
import { checkRateLimit } from "../../../../../lib/rateLimit.js";
import { orgBySlug } from "../../../../../lib/support/settings.js";
import { getPortalUser } from "../../../../../lib/support/portalAuth.js";
import { csrfCheck } from "../../../../../lib/support/portalApi.js";
import { getTicketForCustomer, loadTicket } from "../../../../../lib/support/tickets.js";
import { customerMayReply } from "../../../../../lib/support/messages.js";
import { addAttachment } from "../../../../../lib/support/attachments.js";
import { addIdeaAttachment } from "../../../../../lib/support/ideas.js";

export const dynamic = "force-dynamic";
const MAX = 4 * 1024 * 1024 + 4096;

export async function POST(req, ctx) {
  try {
    const { slug } = await ctx.params;
    const csrf = csrfCheck(req);
    if (csrf) return NextResponse.json({ error: csrf.error }, { status: csrf.status });
    if (Number(req.headers.get("content-length") || 0) > MAX) return NextResponse.json({ error: "The file is larger than 4 MB." }, { status: 413 });
    await ensureOrgIndexes();
    const org = await orgBySlug(slug);
    if (!org) return NextResponse.json({ error: "This portal does not exist." }, { status: 404 });
    const orgId = String(org.orgId); org.settings.portalSlug = org.portalSlug;
    const user = await getPortalUser({ req, orgId });
    if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
    try { await checkRateLimit({ action: `portal:upload:${orgId}`, key: String(user._id), max: 40, windowMs: 3600000 }); } catch { return NextResponse.json({ error: "Too many uploads. Please wait." }, { status: 429 }); }
    const q = new URL(req.url).searchParams;
    const form = await req.formData(); const f = form.get("file");
    if (!f || typeof f === "string" || typeof f.arrayBuffer !== "function") return NextResponse.json({ error: "A file is required." }, { status: 400 });
    if (f.size > MAX) return NextResponse.json({ error: "The file is larger than 4 MB." }, { status: 413 });
    const file = { filename: f.name, buffer: Buffer.from(await f.arrayBuffer()) };
    let r;
    if (q.get("ideaId")) r = await addIdeaAttachment({ orgId, settings: org.settings, user, ideaId: q.get("ideaId"), file });
    else {
      const ticketId = q.get("ticketId");
      const view = ticketId ? await getTicketForCustomer({ orgId, user, ticketId, settings: org.settings }) : null;
      const t = view ? await loadTicket(orgId, ticketId) : null;
      if (!t || !customerMayReply(t, user.email)) return NextResponse.json({ error: "Request not found." }, { status: 404 });
      r = await addAttachment({ orgId, settings: org.settings, ticketId, messageId: q.get("messageId") || null, file, uploader: { type: "customer", email: user.email }, visibility: "PUBLIC" });
    }
    if (r.error) return NextResponse.json({ error: r.error, reasonCode: r.reasonCode }, { status: r.status || 400 });
    return NextResponse.json(r);
  } catch (err) { console.error("portal upload failed:", err?.message); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 }); }
}
