// GET /api/portal/:slug/sso/callback?code=&state= -- finishes the OIDC login, opens a portal session, returns to the portal.
import { NextResponse } from "next/server";
import { ensureOrgIndexes } from "../../../../../../lib/orgs.js";
import { orgBySlug } from "../../../../../../lib/support/settings.js";
import { finishSso } from "../../../../../../lib/support/sso.js";
import { sessionCookie } from "../../../../../../lib/support/portalAuth.js";

export const dynamic = "force-dynamic";
const back = (req, slug, code) => NextResponse.redirect(new URL(`/portal/${slug}?sso_error=${code}`, req.url), 302);

export async function GET(req, ctx) {
  const { slug } = await ctx.params;
  try {
    await ensureOrgIndexes();
    const org = await orgBySlug(slug);
    if (!org) return NextResponse.json({ error: "This portal does not exist." }, { status: 404 });
    const q = new URL(req.url).searchParams;
    if (q.get("error")) return back(req, slug, "denied");
    const r = await finishSso({ orgId: String(org.orgId), settings: org.settings, slug, code: q.get("code"), state: q.get("state") });
    if (r.error) return back(req, slug, r.status === 403 ? "not_allowed" : "failed");
    const res = NextResponse.redirect(new URL(`/portal/${slug}`, req.url), 302);
    res.headers.append("Set-Cookie", sessionCookie(r.sessionToken, r.maxAgeSeconds));
    res.headers.set("Cache-Control", "no-store");
    return res;
  } catch (err) { console.error("portal sso callback failed:", err?.message); return back(req, slug, "failed"); }
}
