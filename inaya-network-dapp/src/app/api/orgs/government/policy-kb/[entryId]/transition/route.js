// app/api/orgs/government/policy-kb/[entryId]/transition/route.js
// POST { orgId, action, note } -> submitForReview | approve | reject

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../../lib/industry-config.js";
import { transitionEntry } from "../../../../../../../lib/policy-knowledge-base.js";

export async function POST(req, { params }) {
  try {
    const { entryId } = params;
    const body = await req.json();
    const { orgId, action } = body;
    if (!orgId || !action) return NextResponse.json({ error: "orgId and action are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "government");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await transitionEntry({ orgId, entryId, action, note: body.note, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ entry: result.entry });
  } catch (err) {
    console.error("orgs/government/policy-kb/[entryId]/transition POST failed:", err);
    return NextResponse.json({ error: "Could not update the entry." }, { status: 500 });
  }
}
