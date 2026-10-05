// src/app/api/orgs/endpoint-backup/_lib.js -- session + membership + FEATURE_ENDPOINT_BACKUP_V2 + uniform errors for endpoint backup. Bodies are never logged.
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../lib/orgs.js";
import { requireFeature } from "../../../../lib/featureFlags.js";
import { BackupError } from "../../../../lib/endpoint/backup.js";
import { getClientIp } from "../../../../lib/rateLimit.js";
export const json = (d, s = 200) => NextResponse.json(d, { status: s, headers: { "Cache-Control": "no-store" } });
export async function route(req, routeCtx, handler) {
  try {
    const url = new URL(req.url); let body = {}; if (req.method !== "GET" && req.method !== "DELETE") { try { body = await req.json(); } catch { body = {}; } }
    const orgId = url.searchParams.get("orgId") || body?.orgId; if (!orgId) return json({ error: "orgId is required." }, 400);
    await ensureOrgIndexes(); const auth = await requireMembership(req, orgId); if (auth.error) return json({ error: auth.error, ...(auth.code ? { code: auth.code } : {}) }, auth.status);
    const off = await requireFeature("FEATURE_ENDPOINT_BACKUP_V2", orgId); if (off) return json({ error: off.error }, off.status);
    const params = routeCtx?.params ? await routeCtx.params : {};
    return json((await handler({ orgId, membership: auth.membership, email: auth.session.email, body, query: Object.fromEntries(url.searchParams.entries()), params, ip: getClientIp(req) })) ?? { ok: true });
  } catch (err) {
    if (err instanceof BackupError) return json({ error: err.message, ...(err.code ? { code: err.code } : {}) }, err.status);
    console.error("endpoint backup route failed:", err?.name, String(err?.message || "").slice(0, 200)); return json({ error: "Something went wrong. Please try again." }, 500);
  }
}
