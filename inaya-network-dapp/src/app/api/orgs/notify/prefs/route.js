// app/api/orgs/notify/prefs/route.js -- your notification preferences (events x channels). GET ?orgId   PUT { orgId, changes: { "<event>": { inApp, email, push, desktop, webhook } } }
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { getPrefs, setPrefs } from "../../../../../lib/notify/router.js";
export const dynamic = "force-dynamic";
const json = (d, s = 200) => NextResponse.json(d, { status: s, headers: { "Cache-Control": "no-store" } });
async function run(req, fn) {
  try { let body = {}; if (req.method !== "GET") { try { body = await req.json(); } catch { body = {}; } } const orgId = new URL(req.url).searchParams.get("orgId") || body.orgId; if (!orgId) return json({ error: "orgId is required." }, 400);
    await ensureOrgIndexes(); const auth = await requireMembership(req, orgId); if (auth.error) return json({ error: auth.error }, auth.status); return json(await fn({ orgId, email: auth.session.email, body })); }
  catch (err) { if (err?.status) return json({ error: err.message }, err.status); console.error("notify prefs failed:", err?.message); return json({ error: "Something went wrong." }, 500); }
}
export const GET = (req) => run(req, ({ orgId, email }) => getPrefs({ orgId, email }));
export const PUT = (req) => run(req, ({ orgId, email, body }) => setPrefs({ orgId, email, changes: body.changes }));
