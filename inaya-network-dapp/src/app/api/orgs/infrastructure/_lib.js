// src/app/api/orgs/infrastructure/_lib.js -- session + membership + FEATURE_INFRASTRUCTURE + canAccessInfrastructure/canManageInfrastructure + uniform errors. Bodies are never logged.
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessInfrastructure, canManageInfrastructure } from "../../../../lib/orgs.js";
import { requireFeature } from "../../../../lib/featureFlags.js";
import { InfrastructureError } from "../../../../lib/infrastructure/nodes.js";

export const json = (d, s = 200) => NextResponse.json(d, { status: s, headers: { "Cache-Control": "no-store" } });

export async function route(req, routeCtx, handler, { requireManage = false } = {}) {
  try {
    const url = new URL(req.url);
    let body = {};
    if (req.method !== "GET" && req.method !== "DELETE") {
      try { body = await req.json(); } catch { body = {}; }
    }
    const orgId = url.searchParams.get("orgId") || body?.orgId;
    if (!orgId) return json({ error: "orgId is required." }, 400);
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return json({ error: auth.error, ...(auth.code ? { code: auth.code } : {}) }, auth.status);
    const off = await requireFeature("FEATURE_INFRASTRUCTURE", orgId);
    if (off) return json({ error: off.error }, off.status);
    const gateOk = requireManage ? canManageInfrastructure(auth.membership) : canAccessInfrastructure(auth.membership);
    if (!gateOk) return json({ error: "You do not have access to Infrastructure." }, 403);
    const params = routeCtx?.params ? await routeCtx.params : {};
    const result = await handler({
      orgId,
      membership: auth.membership,
      email: auth.session.email,
      body,
      query: Object.fromEntries(url.searchParams.entries()),
      params,
    });
    return json(result ?? { ok: true });
  } catch (err) {
    if (err instanceof InfrastructureError) return json({ error: err.message, ...(err.code ? { code: err.code } : {}) }, err.status);
    console.error("infrastructure route failed:", err?.name, String(err?.message || "").slice(0, 200));
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
}
