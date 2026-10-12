// app/api/orgs/guide/prefs/route.js -- the virtual guide's per-user "read hints aloud" preference.
// GET ?orgId   PUT { orgId, readHintsAloud }
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { getGuidePrefs, setGuidePrefs } from "../../../../../lib/guide/prefs.js";

export const dynamic = "force-dynamic";
const json = (d, s = 200) => NextResponse.json(d, { status: s, headers: { "Cache-Control": "no-store" } });

async function run(req, fn) {
  try {
    let body = {};
    if (req.method !== "GET") {
      try { body = await req.json(); } catch { body = {}; }
    }
    const orgId = new URL(req.url).searchParams.get("orgId") || body.orgId;
    if (!orgId) return json({ error: "orgId is required." }, 400);

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return json({ error: auth.error }, auth.status);
    return json(await fn({ orgId, email: auth.session.email, body }));
  } catch (err) {
    console.error("guide prefs failed:", err?.message);
    return json({ error: "Something went wrong." }, 500);
  }
}

export const GET = (req) => run(req, ({ orgId, email }) => getGuidePrefs({ orgId, email }));
export const PUT = (req) => run(req, ({ orgId, email, body }) => setGuidePrefs({ orgId, email, readHintsAloud: body.readHintsAloud }));
