// app/api/orgs/branding/route.js -- organization branding (Competitive Expansion SOW R). Owner/admin only.
//   GET ?orgId    PUT { orgId, portalTitle, accent, supportUrl, logo, favicon, loginBackground, legal:{terms,privacy}, email:{headerColor,footerText} }
//   POST { orgId, action: "domain", domain } | { orgId, action: "verifyDomain" }
// Images are verified PNG/JPEG/WebP data URLs; nothing is rendered as HTML.
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../lib/orgs.js";
import * as B from "../../../../lib/branding/branding.js";
export const dynamic = "force-dynamic";
const json = (d, s = 200) => NextResponse.json(d, { status: s, headers: { "Cache-Control": "no-store" } });
async function run(req, fn) {
  try {
    let body = {}; if (req.method !== "GET") { try { body = await req.json(); } catch { body = {}; } }
    const orgId = new URL(req.url).searchParams.get("orgId") || body.orgId; if (!orgId) return json({ error: "orgId is required." }, 400);
    await ensureOrgIndexes(); const auth = await requireMembership(req, orgId); if (auth.error) return json({ error: auth.error }, auth.status);
    return json(await fn({ orgId, membership: auth.membership, actorEmail: auth.session.email, body }));
  } catch (err) { if (err instanceof B.BrandingError) return json({ error: err.message }, err.status); console.error("branding route failed:", err?.name, String(err?.message || "").slice(0, 200)); return json({ error: "Something went wrong." }, 500); }
}
export const GET = (req) => run(req, ({ orgId, membership }) => B.getBranding({ orgId, membership }));
export const PUT = (req) => run(req, ({ orgId, membership, actorEmail, body }) => { const { orgId: _o, ...input } = body; return B.setBranding({ orgId, membership, actorEmail, input }); });
export const POST = (req) => run(req, ({ orgId, membership, actorEmail, body }) => (body.action === "verifyDomain" ? B.verifyCustomDomain({ orgId, membership, actorEmail }) : B.setCustomDomain({ orgId, membership, actorEmail, domain: body.domain })));
