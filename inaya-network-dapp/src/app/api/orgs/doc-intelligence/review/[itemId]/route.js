// POST /api/orgs/doc-intelligence/review/:itemId  { orgId, action: approve|edit|reject, ...body }
import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../lib/orgs.js";
import { act } from "../../../../../../lib/docIntelligence/review.js";

export const dynamic = "force-dynamic";

export async function POST(req, ctx) {
  try {
    const { itemId } = await ctx.params;
    const { orgId, action, ...body } = await req.json();
    if (!orgId || !action) return NextResponse.json({ error: "orgId and action are required." }, { status: 400 });
    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId); if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const r = await act({ orgId, itemId, action, body, membership: auth.membership, actorEmail: auth.session.email });
    if (r.error) return NextResponse.json({ error: r.error }, { status: r.status || 400 });
    return NextResponse.json(r);
  } catch (err) { console.error("doc-intelligence review action failed:", err?.message); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 }); }
}
