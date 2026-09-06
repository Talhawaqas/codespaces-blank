// app/api/orgs/private-capital/diligence/[requestId]/evidence/route.js
// POST { orgId, documentId?, note? } -> append evidence (never replaces a prior submission)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../../lib/industry-config.js";
import { submitEvidence } from "../../../../../../../lib/due-diligence.js";

export async function POST(req, { params }) {
  try {
    const { requestId } = await params;
    const body = await req.json();
    const { orgId } = body;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "private_capital");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await submitEvidence({ ...body, requestId, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ evidence: result.request.evidence });
  } catch (err) {
    console.error("orgs/private-capital/diligence/[requestId]/evidence POST failed:", err);
    return NextResponse.json({ error: "Could not submit evidence." }, { status: 500 });
  }
}
