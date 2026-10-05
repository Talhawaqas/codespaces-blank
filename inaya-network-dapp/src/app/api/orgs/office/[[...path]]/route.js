// app/api/orgs/office/[[...path]]/route.js -- Microsoft 365 / Office / Outlook integration (Competitive Expansion SOW J). Session + membership.
//   GET  status                       adapter description, what data flows where, real connection state
//   POST sessions { documentId, leaseMinutes? }     start an edit session (lock + short-lived edit token, shown once)
//   GET  sessions?scope=mine|org      edit sessions
//   POST launch { app, fileUrl, mode? }             the Office launch URI for a local or https file
//   POST outlook/links { documentId, expirationPreset|customExpiresAt, options?, note? }   create a secure link and the block to insert
//   GET  outlook/links                links this person inserted from Outlook
//   POST outlook/inspect { url }      status of a pasted secure link (never reveals the token)
//   DELETE outlook/links/{shareId}    revoke
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { requireFeature } from "../../../../../lib/featureFlags.js";
import { getClientIp } from "../../../../../lib/rateLimit.js";
import * as O from "../../../../../lib/integrations/office.js";
import { revokeShare, ShareError } from "../../../../../lib/sharing/shares.js";
export const dynamic = "force-dynamic";
const json = (d, s = 200) => NextResponse.json(d, { status: s, headers: { "Cache-Control": "no-store" } });

async function handle(req, ctx) {
  try {
    const { path = [] } = await ctx.params; const method = req.method; const url = new URL(req.url); const q = Object.fromEntries(url.searchParams.entries());
    let body = {}; if (method === "POST") { try { body = await req.json(); } catch { body = {}; } }
    const orgId = q.orgId || body.orgId; if (!orgId) return json({ error: "orgId is required." }, 400);
    await ensureOrgIndexes(); const auth = await requireMembership(req, orgId); if (auth.error) return json({ error: auth.error }, auth.status);
    const membership = auth.membership, email = auth.session.email; const [a, b, c] = path;
    if (a === "status" && method === "GET") return json(await O.adapterStatus({ orgId }));
    if (a === "launch" && method === "POST") return json({ uri: O.buildLaunchUri({ app: body.app, fileUrl: body.fileUrl, mode: body.mode }) });
    if (a === "sessions") {
      if (method === "POST") { const off = await requireFeature("FEATURE_ADVANCED_SHARING", orgId); if (off) return json({ error: off.error }, off.status); return json(await O.startEditSession({ orgId, membership, email, documentId: body.documentId, leaseMinutes: body.leaseMinutes }), 201); }
      if (method === "GET") return json(await O.listSessions({ orgId, membership, email, scope: q.scope === "org" ? "org" : "mine" }));
    }
    if (a === "outlook") {
      const off = await requireFeature("FEATURE_ADVANCED_SHARING", orgId); if (off) return json({ error: off.error }, off.status);
      if (b === "links" && !c && method === "POST") return json(await O.createOutlookLink({ orgId, membership, email, documentId: body.documentId, origin: url.origin, expirationPreset: body.expirationPreset, customExpiresAt: body.customExpiresAt, options: body.options || {}, note: body.note || "", ip: getClientIp(req) }), 201);
      if (b === "links" && !c && method === "GET") return json(await O.listOutlookLinks({ orgId, email }));
      if (b === "links" && c && method === "DELETE") return json(await revokeShare({ orgId, shareId: c, actorEmail: email, membership }));
      if (b === "inspect" && method === "POST") return json(await O.inspectLink({ url: body.url }));
    }
    return json({ error: "Not found." }, 404);
  } catch (err) {
    if (err instanceof O.OfficeError || err instanceof ShareError) return json({ error: err.message, ...(err.code ? { code: err.code } : {}), ...(err.latestVersionId ? { latestVersionId: err.latestVersionId } : {}), ...(err.lockedBy ? { lockedBy: err.lockedBy, expiresAt: err.expiresAt } : {}) }, err.status);
    if (err?.name === "LockError" || typeof err?.status === "number") return json({ error: err.message, ...(err.lockedBy ? { lockedBy: err.lockedBy } : {}) }, err.status);
    console.error("orgs/office failed:", err?.name, String(err?.message || "").slice(0, 200)); return json({ error: "Something went wrong. Please try again." }, 500);
  }
}
export const GET = handle, POST = handle, DELETE = handle;
