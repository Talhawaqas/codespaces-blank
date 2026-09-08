// app/api/orgs/government/cases/[caseId]/transition/route.js
// POST { orgId, action, ownerEmail, note } -> advance a case through its state machine

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../../lib/industry-config.js";
import { transitionCase } from "../../../../../../../lib/government-cases.js";

export async function POST(req, { params }) {
  try {
    const { caseId } = params;
    const body = await req.json();
    const { orgId, action } = body;
    if (!orgId || !action) return NextResponse.json({ error: "orgId and action are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "government");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await transitionCase({ orgId, caseId, action, ownerEmail: body.ownerEmail, note: body.note, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ case: result.case });
  } catch (err) {
    console.error("orgs/government/cases/[caseId]/transition POST failed:", err);
    return NextResponse.json({ error: "Could not update the case." }, { status: 500 });
  }
}
