// app/api/orgs/webhooks/_lib.js -- session + membership + uniform errors for the organization webhook registry. No feature flag: webhooks are an integration
// surface that only does anything when an admin creates an endpoint. Bodies are never logged.
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../lib/orgs.js";
import { WebhookError } from "../../../../lib/webhooks/registry.js";
export const json = (d, s = 200) => NextResponse.json(d, { status: s, headers: { "Cache-Control": "no-store" } });
export async function route(req, routeCtx, handler) {
  try {
    const url = new URL(req.url); let body = {}; if (req.method !== "GET" && req.method !== "DELETE") { try { body = await req.json(); } catch { body = {}; } }
    const orgId = url.searchParams.get("orgId") || body?.orgId; if (!orgId) return json({ error: "orgId is required." }, 400);
    await ensureOrgIndexes(); const auth = await requireMembership(req, orgId); if (auth.error) return json({ error: auth.error }, auth.status);
    const params = routeCtx?.params ? await routeCtx.params : {};
    return json((await handler({ orgId, membership: auth.membership, email: auth.session.email, body, query: Object.fromEntries(url.searchParams.entries()), params })) ?? { ok: true });
  } catch (err) {
    if (err instanceof WebhookError) return json({ error: err.message }, err.status);
    console.error("webhooks route failed:", err?.name, String(err?.message || "").slice(0, 200)); return json({ error: "Something went wrong. Please try again." }, 500);
  }
}
