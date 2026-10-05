// app/api/orgs/file-requests/_lib.js -- session + membership + FEATURE_ADVANCED_SHARING + uniform errors for the requester-side routes.
// (The uploader-side routes under /api/public/file-requests are public by design.) Bodies are never logged.
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../lib/orgs.js";
import { requireFeature } from "../../../../lib/featureFlags.js";
import { RequestError } from "../../../../lib/filerequests/requests.js";

export const json = (data, status = 200) => NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });

export async function requesterRoute(req, routeCtx, handler) {
  try {
    const url = new URL(req.url);
    let body = {}; if (req.method !== "GET" && req.method !== "HEAD") { try { body = await req.json(); } catch { body = {}; } }
    const orgId = url.searchParams.get("orgId") || body?.orgId;
    if (!orgId) return json({ error: "orgId is required." }, 400);
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return json({ error: auth.error }, auth.status);
    const off = await requireFeature("FEATURE_ADVANCED_SHARING", orgId);
    if (off) return json({ error: off.error }, off.status);
    const params = routeCtx?.params ? await routeCtx.params : {};
    return json((await handler({ orgId, membership: auth.membership, email: auth.session.email, body, query: Object.fromEntries(url.searchParams.entries()), params })) ?? { ok: true });
  } catch (err) {
    if (err instanceof RequestError) return json({ error: err.message }, err.status);
    console.error("file-requests route failed:", err?.name, String(err?.message || "").slice(0, 200));
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
}
