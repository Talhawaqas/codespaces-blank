// app/api/orgs/regulated/evidence/[evidenceId]/review/route.js
// PATCH { orgId, reviewStatus } -> approve or reject a pending evidence row

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../../lib/industry-config.js";
import { reviewEvidence } from "../../../../../../../lib/compliance-evidence.js";

function serialize(e) {
  return {
    id: e._id.toString(), controlId: e.controlId?.toString() || null, type: e.type,
    reviewStatus: e.reviewStatus, reviewerEmail: e.reviewerEmail, reviewedAt: e.reviewedAt,
  };
}

export async function PATCH(req, { params }) {
  try {
    const { evidenceId } = await params;
    const { orgId, reviewStatus } = await req.json();
    if (!orgId || !reviewStatus) return NextResponse.json({ error: "orgId and reviewStatus are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "regulated");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await reviewEvidence({ orgId, evidenceId, reviewStatus, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ evidence: serialize(result.evidence) });
  } catch (err) {
    console.error("orgs/regulated/evidence/[evidenceId]/review PATCH failed:", err);
    return NextResponse.json({ error: "Could not review evidence." }, { status: 500 });
  }
}
