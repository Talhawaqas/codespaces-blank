// app/api/public/v1/_lib.js -- shared plumbing for the Competitive Expansion public API families (shares, file-requests, governance, classification,
// devices). Same org-binding guarantee as the other public/v1 routes: the orgId comes from the API key, never from the request. The key resolves to an
// owner-level membership (see api-keys.js) and every action is attributed to the member who created the key. Each family keeps its feature flag: a flag
// that is off for the organization answers exactly as the app does. Request bodies are never logged. File content never flows through this API
// (documents are client-side encrypted).

import { NextResponse } from "next/server";
import { ensureOrgIndexes, getOrgCollections, hashToken } from "../../../../lib/orgs.js";
import { requireApiKey } from "../../../../lib/api-keys.js";
import { requireFeature } from "../../../../lib/featureFlags.js";

export const json = (d, s = 200) => NextResponse.json(d, { status: s, headers: { "Cache-Control": "no-store" } });

export async function publicRoute(req, routeCtx, { flag = null }, handler) {
  try {
    await ensureOrgIndexes();
    const auth = await requireApiKey(req);
    if (auth.error) return json({ error: auth.error }, auth.status);
    if (flag) { const off = await requireFeature(flag, auth.orgId); if (off) return json({ error: off.error }, off.status); }
    const { apiKeys } = await getOrgCollections();
    const key = await apiKeys.findOne({ tokenHash: hashToken(req.headers.get("authorization").slice(7).trim()), revokedAt: null }, { projection: { createdByEmail: 1 } });
    const url = new URL(req.url);
    let body = {};
    if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") { try { body = await req.json(); } catch { body = {}; } }
    const params = routeCtx?.params ? await routeCtx.params : {};
    return json((await handler({ orgId: auth.orgId, membership: auth.membership, email: key?.createdByEmail || "api@inaya.invalid", body, query: Object.fromEntries(url.searchParams.entries()), params })) ?? { ok: true });
  } catch (err) {
    if (typeof err?.status === "number" && err.status < 500) return json({ error: err.message, ...(err.code ? { code: err.code } : {}), ...(err.errors ? { errors: err.errors } : {}) }, err.status);
    console.error("public/v1 route failed:", err?.name, String(err?.message || "").slice(0, 200));
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
}
