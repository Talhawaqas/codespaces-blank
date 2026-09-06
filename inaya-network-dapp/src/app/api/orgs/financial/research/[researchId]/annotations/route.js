// app/api/orgs/financial/research/[researchId]/annotations/route.js
// POST { orgId, note } -> append an annotation (append-only, never rewrites a prior note)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../../lib/industry-config.js";
import { addAnnotation } from "../../../../../../../lib/investment-research.js";

export async function POST(req, { params }) {
  try {
    const { researchId } = await params;
    const { orgId, note } = await req.json();
    if (!orgId || !note) return NextResponse.json({ error: "orgId and note are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "financial");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await addAnnotation({ orgId, researchId, note, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ annotations: result.research.annotations });
  } catch (err) {
    console.error("orgs/financial/research/[researchId]/annotations POST failed:", err);
    return NextResponse.json({ error: "Could not add annotation." }, { status: 500 });
  }
}
