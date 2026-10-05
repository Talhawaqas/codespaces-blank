// app/api/orgs/governance/_lib.js -- session + membership + feature flag + uniform errors for the governance routes. Bodies are never logged.
//   FEATURE_FILE_GOVERNANCE        policies (except dlp/classification), metadata, upload rules, sharing limits
//   FEATURE_DLP                    DLP policies, events, approvals, simulation
//   FEATURE_SMART_CLASSIFICATION   classification rules, classification, history
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../lib/orgs.js";
import { requireFeature } from "../../../../lib/featureFlags.js";
import { GovError } from "../../../../lib/governance/policies.js";

export const json = (data, status = 200) => NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
export const flagForType = (type) => (type === "dlp" ? "FEATURE_DLP" : type === "classification" ? "FEATURE_SMART_CLASSIFICATION" : "FEATURE_FILE_GOVERNANCE");

export async function govRoute(req, routeCtx, flag, handler) {
  try {
    const url = new URL(req.url);
    let body = {}; if (req.method !== "GET" && req.method !== "HEAD") { try { body = await req.json(); } catch { body = {}; } }
    const orgId = url.searchParams.get("orgId") || body?.orgId;
    if (!orgId) return json({ error: "orgId is required." }, 400);
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return json({ error: auth.error }, auth.status);
    if (flag) { const off = await requireFeature(flag, orgId); if (off) return json({ error: off.error }, off.status); }
    const params = routeCtx?.params ? await routeCtx.params : {};
    const ctx = { orgId, membership: auth.membership, email: auth.session.email, body, query: Object.fromEntries(url.searchParams.entries()), params, req, flagCheck: async (f) => { const o = await requireFeature(f, orgId); if (o) throw new GovError(o.status, o.error); } };
    return json((await handler(ctx)) ?? { ok: true });
  } catch (err) {
    if (err instanceof GovError || err?.name === "DlpBlocked") return json({ error: err.message, ...(err.code ? { code: err.code } : {}), ...(err.errors ? { errors: err.errors } : {}) }, err.status || 403);
    console.error("governance route failed:", err?.name, String(err?.message || "").slice(0, 200));
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
}
