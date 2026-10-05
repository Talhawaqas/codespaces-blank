// app/api/orgs/notes/_lib.js -- session + membership + FEATURE_SECURE_NOTES + uniform errors for the Secure Notes routes. Bodies are never logged.
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../lib/orgs.js";
import { requireFeature } from "../../../../lib/featureFlags.js";
import { NoteError } from "../../../../lib/notes/notes.js";

export const json = (data, status = 200) => NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });

export async function notesRoute(req, routeCtx, handler) {
  try {
    const url = new URL(req.url);
    let body = {}; if (req.method !== "GET" && req.method !== "HEAD") { try { body = await req.json(); } catch { body = {}; } }
    const orgId = url.searchParams.get("orgId") || body?.orgId;
    if (!orgId) return json({ error: "orgId is required." }, 400);
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return json({ error: auth.error }, auth.status);
    const off = await requireFeature("FEATURE_SECURE_NOTES", orgId);
    if (off) return json({ error: off.error }, off.status);
    const params = routeCtx?.params ? await routeCtx.params : {};
    return json((await handler({ orgId, membership: auth.membership, email: auth.session.email, body, query: Object.fromEntries(url.searchParams.entries()), params })) ?? { ok: true });
  } catch (err) {
    if (err instanceof NoteError) return json({ error: err.message, ...(err.code ? { code: err.code } : {}), ...(err.currentRev ? { currentRev: err.currentRev } : {}), ...(err.latest ? { latest: err.latest } : {}), ...(err.keyVersion ? { keyVersion: err.keyVersion } : {}) }, err.status);
    console.error("notes route failed:", err?.name, String(err?.message || "").slice(0, 200));
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
}
