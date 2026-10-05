// app/api/orgs/shares/_lib.js
//
// Shared plumbing for the Secure Sharing 2.0 routes that need a signed-in organization member: session + membership, the
// FEATURE_ADVANCED_SHARING flag, and uniform error output. (The recipient-facing routes under /api/orgs/share/[token] are public by
// design and use publicShareRoute in their own files.) Request bodies are never logged.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../lib/orgs.js";
import { requireFeature } from "../../../../lib/featureFlags.js";
import { ShareError } from "../../../../lib/sharing/shares.js";

export const json = (data, status = 200) => NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });

export async function shareRoute(req, routeCtx, handler, { feature = true } = {}) {
  try {
    const url = new URL(req.url);
    let body = {};
    if (req.method !== "GET" && req.method !== "HEAD") { try { body = await req.json(); } catch { body = {}; } }
    const orgId = url.searchParams.get("orgId") || body?.orgId;
    if (!orgId) return json({ error: "orgId is required." }, 400);
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return json({ error: auth.error }, auth.status);
    if (feature) { const off = await requireFeature("FEATURE_ADVANCED_SHARING", orgId); if (off) return json({ error: off.error }, off.status); }
    const params = routeCtx?.params ? await routeCtx.params : {};
    const out = await handler({ orgId, membership: auth.membership, email: auth.session.email, body, query: Object.fromEntries(url.searchParams.entries()), params, req });
    return json(out ?? { ok: true });
  } catch (err) {
    if (err instanceof ShareError) return json({ error: err.message, ...(err.needs ? { needs: err.needs } : {}) }, err.status);
    console.error("shares route failed:", err?.name, String(err?.message || "").slice(0, 200));
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
}
