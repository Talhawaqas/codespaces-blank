// app/api/orgs/pqc/devices/_lib.js -- session + membership + FEATURE_PQC + uniform errors for the PQC device-key routes.
// Same shape as ../devices/_lib.js (device inventory's own wrapper) -- deliberately not shared code, since the two gate
// on different feature flags and throw different error classes, but intentionally identical structure so this route
// group reads the same way the rest of the codebase already does. Bodies are never logged.
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, getRawSessionToken } from "../../../../../lib/orgs.js";
import { requireFeature } from "../../../../../lib/featureFlags.js";
import { PqcDeviceKeyError } from "../../../../../lib/pqc/deviceKeys.js";
import { hasAdminRole } from "../../../../../lib/orgGates.js";

export const json = (d, s = 200) => NextResponse.json(d, { status: s, headers: { "Cache-Control": "no-store" } });

export async function pqcRoute(req, routeCtx, handler) {
  try {
    const url = new URL(req.url);
    let body = {};
    if (req.method !== "GET") { try { body = await req.json(); } catch { body = {}; } }
    const orgId = url.searchParams.get("orgId") || body?.orgId;
    if (!orgId) return json({ error: "orgId is required." }, 400);
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return json({ error: auth.error, ...(auth.code ? { code: auth.code } : {}) }, auth.status);
    const off = await requireFeature("FEATURE_PQC", orgId);
    if (off) return json({ error: off.error }, off.status);
    const params = routeCtx?.params ? await routeCtx.params : {};
    const result = await handler({
      orgId,
      membership: auth.membership,
      email: auth.session.email,
      body,
      query: Object.fromEntries(url.searchParams.entries()),
      params,
      sessionToken: getRawSessionToken(req),
      hasAdminRole,
    });
    return json(result ?? { ok: true });
  } catch (err) {
    if (err instanceof PqcDeviceKeyError) return json({ error: err.message, ...(err.code ? { code: err.code } : {}) }, err.status);
    console.error("pqc devices route failed:", err?.name, String(err?.message || "").slice(0, 200));
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
}
