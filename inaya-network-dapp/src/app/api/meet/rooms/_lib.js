// app/api/meet/rooms/_lib.js -- session + membership + FEATURE_MEET + uniform errors for Meet's
// routes. Two wrappers: meetRoute (an org session is required -- create/list/moderate/end a
// meeting) and meetOpenRoute (an org session is OPTIONAL -- join/leave/signal, which a guest with
// no account must also be able to call). Same shape as ../../orgs/pqc/devices/_lib.js, deliberately
// not shared code since the auth requirement genuinely differs.
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../lib/orgs.js";
import { requireFeature } from "../../../../lib/featureFlags.js";
import { MeetError } from "../../../../lib/meet/common.js";
import { hasAdminRole } from "../../../../lib/orgGates.js";

export const json = (d, s = 200) => NextResponse.json(d, { status: s, headers: { "Cache-Control": "no-store" } });

async function readBody(req) { if (req.method === "GET") return {}; try { return await req.json(); } catch { return {}; } }

export async function meetRoute(req, routeCtx, handler) {
  try {
    const url = new URL(req.url);
    const body = await readBody(req);
    const orgId = url.searchParams.get("orgId") || body?.orgId;
    if (!orgId) return json({ error: "orgId is required." }, 400);
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return json({ error: auth.error, ...(auth.code ? { code: auth.code } : {}) }, auth.status);
    const off = await requireFeature("FEATURE_MEET", orgId);
    if (off) return json({ error: off.error }, off.status);
    const params = routeCtx?.params ? await routeCtx.params : {};
    const result = await handler({ orgId, membership: auth.membership, email: auth.session.email, body, query: Object.fromEntries(url.searchParams.entries()), params, hasAdminRole });
    return json(result ?? { ok: true });
  } catch (err) {
    if (err instanceof MeetError) return json({ error: err.message, ...(err.code ? { code: err.code } : {}) }, err.status);
    console.error("meet route failed:", err?.name, String(err?.message || "").slice(0, 200));
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
}

/** Resolves an org session if one is present and valid; otherwise `membership`/`email` are null --
 *  the handler decides what a null-identity caller (a guest) may do from there. FEATURE_MEET is
 *  still required either way. */
export async function meetOpenRoute(req, routeCtx, handler) {
  try {
    const url = new URL(req.url);
    const body = await readBody(req);
    const orgId = url.searchParams.get("orgId") || body?.orgId;
    if (!orgId) return json({ error: "orgId is required." }, 400);
    await ensureOrgIndexes();
    const off = await requireFeature("FEATURE_MEET", orgId);
    if (off) return json({ error: off.error }, off.status);
    let membership = null, email = null;
    const auth = await requireMembership(req, orgId).catch(() => null);
    if (auth && !auth.error && auth.session?.email) { membership = auth.membership; email = auth.session.email; }
    const params = routeCtx?.params ? await routeCtx.params : {};
    const result = await handler({ orgId, membership, email, body, query: Object.fromEntries(url.searchParams.entries()), params });
    if (result instanceof Response) return result; // the SSE stream route returns its own Response
    return json(result ?? { ok: true });
  } catch (err) {
    if (err instanceof MeetError) return json({ error: err.message, ...(err.code ? { code: err.code } : {}) }, err.status);
    console.error("meet open route failed:", err?.name, String(err?.message || "").slice(0, 200));
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
}
