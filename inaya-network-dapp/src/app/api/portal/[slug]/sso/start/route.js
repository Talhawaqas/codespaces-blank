// GET /api/portal/:slug/sso/start -- sends the browser to the organization's identity provider (OIDC + PKCE).
import { NextResponse } from "next/server";
import { ensureOrgIndexes } from "../../../../../../lib/orgs.js";
import { orgBySlug } from "../../../../../../lib/support/settings.js";
import { startSso } from "../../../../../../lib/support/sso.js";
import { checkRateLimit } from "../../../../../../lib/rateLimit.js";

export const dynamic = "force-dynamic";

const back = (req, slug, code) => NextResponse.redirect(new URL(`/portal/${slug}?sso_error=${code}`, req.url), 302);

export async function GET(req, ctx) {
  const { slug } = await ctx.params;
  try {
    await ensureOrgIndexes();
    const org = await orgBySlug(slug);
    if (!org) return NextResponse.json({ error: "This portal does not exist." }, { status: 404 });
    const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
    try { await checkRateLimit({ action: `portal:sso:start:${org.orgId}`, key: ip, max: 40, windowMs: 3600000 }); } catch { return back(req, slug, "rate_limited"); }
    const r = await startSso({ orgId: String(org.orgId), settings: org.settings, slug });
    if (r.error) return back(req, slug, "unavailable");
    return NextResponse.redirect(r.url, 302);
  } catch (err) { console.error("portal sso start failed:", err?.message); return back(req, slug, "unavailable"); }
}
