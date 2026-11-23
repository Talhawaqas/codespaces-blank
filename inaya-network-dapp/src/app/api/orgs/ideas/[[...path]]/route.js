// app/api/orgs/ideas/[[...path]]/route.js -- "Suggest an improvement" (post-SOW #6): Workspace customers send ideas to Inaya.
//   GET  ?orgId                      { mine, board }   (board = ideas Inaya put on the public board: title + status + votes only)
//   POST { orgId, title, problem, importance }        submit
//   POST ideas/{id}/vote { orgId, on }               +1 / remove +1
// Membership first (requireMembership also applies the License Manager gate); logic in src/lib/workspaceIdeas.js.
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { submitIdea, listIdeas, voteIdea } from "../../../../../lib/workspaceIdeas.js";

export const dynamic = "force-dynamic";
const json = (d, s = 200) => NextResponse.json(d, { status: s, headers: { "Cache-Control": "no-store" } });
const out = (r) => (r?.error ? json({ error: r.error }, r.status || 400) : json(r));
async function ctx(req, orgId) {
  if (!orgId) return { error: json({ error: "orgId is required." }, 400) };
  await ensureOrgIndexes(); const auth = await requireMembership(req, orgId);
  return auth.error ? { error: json({ error: auth.error }, auth.status) } : { membership: auth.membership, email: auth.session.email };
}
export async function GET(req) {
  try { const orgId = new URL(req.url).searchParams.get("orgId"); const c = await ctx(req, orgId); if (c.error) return c.error; return out(await listIdeas({ orgId, email: c.email })); }
  catch (e) { console.error("ideas GET failed:", e); return json({ error: "Could not load ideas." }, 500); }
}
export async function POST(req, { params }) {
  params = await params; const seg = params.path || [];
  try {
    const body = await req.json().catch(() => ({})); const c = await ctx(req, body.orgId); if (c.error) return c.error;
    if (!seg.length) return out(await submitIdea({ orgId: body.orgId, orgName: c.membership.orgName, email: c.email, input: body }));
    if (seg[1] === "vote") return out(await voteIdea({ orgId: body.orgId, email: c.email, id: seg[0], on: body.on !== false }));
    return json({ error: "Not found." }, 404);
  } catch (e) { console.error("ideas POST failed:", e); return json({ error: "Could not save." }, 500); }
}
