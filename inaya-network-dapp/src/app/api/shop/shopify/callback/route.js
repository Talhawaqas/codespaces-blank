// GET /api/shop/shopify/callback -- Shopify sends the shop owner back here after they approve "Install Inaya". The person must
// still be signed in to Inaya as the one who started the connection; everything is verified in src/lib/online/shopifyApp.js.
import { NextResponse } from "next/server";
import { getRawSessionToken, getSession, getMembership } from "../../../../../lib/orgs.js";
import { completeShopifyInstall } from "../../../../../lib/online/shopifyApp.js";
import { companyMayOperate } from "../../../../../lib/licensing/gate.js";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function GET(req) {
  const url = new URL(req.url); const back = (q) => NextResponse.redirect(new URL(`/business?view=online&${q}`, url.origin));
  try {
    const session = await getSession(getRawSessionToken(req));
    if (!session) return back(`shopify_error=${encodeURIComponent("Sign in to Inaya, then connect Shopify again.")}`);
    const r = await completeShopifyInstall({ params: url.searchParams, sessionEmail: session.email, resolveMembership: async (orgId) => ((await companyMayOperate(orgId)) ? getMembership(orgId, session.email).catch(() => null) : null) }); // a restricted company can't link a store (License Manager gate)
    if (r.error) return back(`shopify_error=${encodeURIComponent(r.error)}`);
    return back(`shopify=connected${r.missingScopes?.length ? `&shopify_missing=${encodeURIComponent(r.missingScopes.join(","))}` : ""}`);
  } catch (e) { console.error("shopify callback failed:", e.message); return back(`shopify_error=${encodeURIComponent("Something went wrong connecting Shopify. Try again.")}`); }
}
