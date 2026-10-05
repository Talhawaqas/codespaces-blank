// app/api/orgs/portal-requests/[[...path]]/route.js -- customer portal requests, staff side (Competitive Expansion SOW L). Session + membership; support staff only.
//   GET  ?status=&customerEmail=            list              POST { customerEmail, title, instructions?, dueAt?, items[] }   create
//   GET  {id}                                one request with history, files and (decrypted for staff, audited) form answers
//   POST {id}/cancel { reason? }   POST {id}/comments { text }   POST {id}/remind
//   PUT  {id}/items/{itemId}/file?filename=  release a file (raw bytes, up to 4 MB) for a "download" item
//   GET  {id}/files/{fileId}                 download a file (audited)
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { getSettings } from "../../../../../lib/support/settings.js";
import { DOWNLOAD_HEADERS } from "../../../../../lib/support/attachments.js";
import * as PR from "../../../../../lib/support/portalRequests.js";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
const json = (d, s = 200) => NextResponse.json(d, { status: s, headers: { "Cache-Control": "no-store" } });
const out = (r) => (r?.error ? json({ error: r.error, ...(r.reasonCode ? { reasonCode: r.reasonCode } : {}), ...(r.errors ? { errors: r.errors } : {}) }, r.status || 400) : json(r));

async function handle(req, ctx) {
  try {
    const { path = [] } = await ctx.params; const method = req.method; const url = new URL(req.url); const q = Object.fromEntries(url.searchParams.entries()); const [id, a, b, c] = path;
    const isRaw = method === "PUT" && a === "items" && c === "file"; let body = {};
    if (!isRaw && (method === "POST" || method === "PUT")) { try { body = await req.json(); } catch { body = {}; } }
    const orgId = q.orgId || body.orgId; if (!orgId) return json({ error: "orgId is required." }, 400);
    await ensureOrgIndexes(); const auth = await requireMembership(req, orgId); if (auth.error) return json({ error: auth.error }, auth.status);
    const membership = auth.membership, email = auth.session.email; const settings = await getSettings(orgId); const base = { orgId, membership, actorEmail: email };
    if (!id) return out(method === "POST" ? await PR.createRequest({ ...base, settings, customerEmail: body.customerEmail, title: body.title, instructions: body.instructions, dueAt: body.dueAt, items: body.items }) : await PR.listRequests({ ...base, status: q.status, customerEmail: q.customerEmail, limit: q.limit, before: q.before }));
    if (!a && method === "GET") return out(await PR.getRequestStaff({ ...base, requestId: id }));
    if (a === "cancel" && method === "POST") return out(await PR.cancelRequest({ ...base, requestId: id, reason: body.reason }));
    if (a === "comments" && method === "POST") return out(await PR.staffComment({ ...base, settings, requestId: id, text: body.text }));
    if (a === "remind" && method === "POST") return out(await PR.remind({ ...base, settings, requestId: id }));
    if (isRaw) {
      if (Number(req.headers.get("content-length") || 0) > PR.LIMITS.fileBytes + 1024) return json({ error: "A file can be at most 4 MB here." }, 413);
      const buf = Buffer.from(await req.arrayBuffer()); return out(await PR.releaseFile({ ...base, settings, requestId: id, itemId: b, filename: q.filename, buffer: buf }));
    }
    if (a === "files" && b && method === "GET") { const f = await PR.getFileForDownload({ orgId, requestId: id, fileId: b, viewer: { kind: "staff", membership }, actorEmail: email }); if (!f) return json({ error: "File not found." }, 404); return new NextResponse(f.buffer, { status: 200, headers: DOWNLOAD_HEADERS(f.filename, f.contentType) }); }
    return json({ error: "Not found." }, 404);
  } catch (err) { console.error("orgs/portal-requests failed:", err?.name, String(err?.message || "").slice(0, 200)); return json({ error: "Something went wrong. Please try again." }, 500); }
}
export const GET = handle, POST = handle, PUT = handle;
