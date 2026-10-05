// app/api/orgs/devices/_lib.js -- session + membership + FEATURE_DEVICE_CONTROL + uniform errors for the device routes. Bodies are never logged.
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, getRawSessionToken } from "../../../../lib/orgs.js";
import { requireFeature } from "../../../../lib/featureFlags.js";
import { DeviceError } from "../../../../lib/devices/devices.js";
import { getClientIp } from "../../../../lib/rateLimit.js";

export const json = (d, s = 200) => NextResponse.json(d, { status: s, headers: { "Cache-Control": "no-store" } });
export async function deviceRoute(req, routeCtx, handler) {
  try {
    const url = new URL(req.url); let body = {}; if (req.method !== "GET") { try { body = await req.json(); } catch { body = {}; } }
    const orgId = url.searchParams.get("orgId") || body?.orgId; if (!orgId) return json({ error: "orgId is required." }, 400);
    await ensureOrgIndexes(); const auth = await requireMembership(req, orgId); if (auth.error) return json({ error: auth.error, ...(auth.code ? { code: auth.code } : {}) }, auth.status);
    const off = await requireFeature("FEATURE_DEVICE_CONTROL", orgId); if (off) return json({ error: off.error }, off.status);
    const params = routeCtx?.params ? await routeCtx.params : {};
    return json((await handler({ orgId, membership: auth.membership, email: auth.session.email, body, query: Object.fromEntries(url.searchParams.entries()), params, ip: getClientIp(req), sessionToken: getRawSessionToken(req) })) ?? { ok: true });
  } catch (err) {
    if (err instanceof DeviceError) return json({ error: err.message, ...(err.code ? { code: err.code } : {}) }, err.status);
    console.error("devices route failed:", err?.name, String(err?.message || "").slice(0, 200)); return json({ error: "Something went wrong. Please try again." }, 500);
  }
}
