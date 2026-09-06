// app/api/orgs/financial/theses/[thesisId]/transition/route.js
// PATCH { orgId, action, note? } -> submitForReview / submitToIC / returnToDraft / approve / reject / activate / beginMonitoring / close

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../../lib/industry-config.js";
import { transitionThesis } from "../../../../../../../lib/investment-thesis.js";

function serialize(t) {
  return { id: t._id.toString(), key: t.key, version: t.version, status: t.status };
}

export async function PATCH(req, { params }) {
  try {
    const { thesisId } = await params;
    const { orgId, action, note } = await req.json();
    if (!orgId || !action) return NextResponse.json({ error: "orgId and action are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "financial");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await transitionThesis({ orgId, thesisId, action, note, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ thesis: serialize(result.thesis) });
  } catch (err) {
    console.error("orgs/financial/theses/[thesisId]/transition PATCH failed:", err);
    return NextResponse.json({ error: "Could not update thesis." }, { status: 500 });
  }
}
