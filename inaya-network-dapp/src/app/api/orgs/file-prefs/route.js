// app/api/orgs/file-prefs/route.js -- your own favorites, pins, tags and recent for documents (personal; grants nothing).
//   GET ?orgId                      your tags
//   POST { orgId, documentId, favorite?, pinned?, addTag?, removeTag?, touch? }   needs view access to the document
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../lib/orgs.js";
import { PrefsError, listTags, setPrefs } from "../../../../lib/filePrefs.js";
export const dynamic = "force-dynamic";
const json = (d, s = 200) => NextResponse.json(d, { status: s, headers: { "Cache-Control": "no-store" } });
export async function GET(req) {
  const orgId = new URL(req.url).searchParams.get("orgId"); if (!orgId) return json({ error: "orgId is required." }, 400);
  await ensureOrgIndexes(); const auth = await requireMembership(req, orgId); if (auth.error) return json({ error: auth.error }, auth.status); return json(await listTags({ orgId, email: auth.session.email }));
}
export async function POST(req) {
  try {
    let body = {}; try { body = await req.json(); } catch { body = {}; } const { orgId, documentId } = body; if (!orgId || !documentId) return json({ error: "orgId and documentId are required." }, 400);
    await ensureOrgIndexes(); const auth = await requireMembership(req, orgId); if (auth.error) return json({ error: auth.error }, auth.status);
    return json(await setPrefs({ orgId, email: auth.session.email, membership: auth.membership, documentId, favorite: body.favorite, pinned: body.pinned, addTag: body.addTag, removeTag: body.removeTag, touch: !!body.touch }));
  } catch (err) { if (err instanceof PrefsError) return json({ error: err.message }, err.status); console.error("file-prefs failed:", err?.message); return json({ error: "Something went wrong." }, 500); }
}
