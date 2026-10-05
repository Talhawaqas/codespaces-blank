// app/api/orgs/chat/_lib.js
//
// Shared plumbing for every Secure Chat route: session + membership (the ordinary org auth), the FEATURE_SECURE_CHAT flag,
// the calling device (header x-inaya-device, or deviceId in the query/body), and uniform error output. Chat request and
// response bodies are NEVER logged: an unexpected error logs only its name and message.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../lib/orgs.js";
import { requireFeature } from "../../../../lib/featureFlags.js";
import { ChatError } from "../../../../lib/chat/common.js";

const json = (data, status = 200) => NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
export { json };

async function readBody(req) {
  if (req.method === "GET" || req.method === "HEAD") return {};
  if (req.method === "DELETE" && !String(req.headers.get("content-type") || "").includes("json")) return {};
  try { return await req.json(); } catch { return {}; }
}

/**
 * handler(ctx) receives { orgId, membership, email, deviceId, body, query, req, params }.
 * Returns the JSON-able result (or a Response for streams).
 */
export async function chatRoute(req, routeCtx, handler, { feature = true } = {}) {
  try {
    const url = new URL(req.url);
    const body = await readBody(req);
    const orgId = url.searchParams.get("orgId") || body?.orgId;
    if (!orgId) return json({ error: "orgId is required." }, 400);
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return json({ error: auth.error }, auth.status);
    if (feature) { const off = await requireFeature("FEATURE_SECURE_CHAT", orgId); if (off) return json({ error: off.error }, off.status); }
    const params = routeCtx?.params ? await routeCtx.params : {};
    const deviceId = req.headers.get("x-inaya-device") || url.searchParams.get("deviceId") || body?.deviceId || null;
    const query = Object.fromEntries(url.searchParams.entries());
    const result = await handler({ orgId, membership: auth.membership, email: auth.session.email, deviceId, body, query, req, params });
    if (result instanceof Response) return result;
    return json(result ?? { ok: true });
  } catch (err) {
    if (err instanceof ChatError) return json({ error: err.message, code: err.code }, err.status);
    console.error("chat route failed:", err?.name, String(err?.message || "").slice(0, 200));
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
}
