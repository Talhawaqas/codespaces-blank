// app/api/orgs/regulated/findings/[findingId]/transition/route.js
// PATCH { orgId, action, note?, ownerEmail?, compensatingControl? } -> assign / startRemediation / submitForValidation / validate / close / reopen

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../../lib/industry-config.js";
import { transitionFinding } from "../../../../../../../lib/control-testing.js";

function serialize(f) {
  return {
    id: f._id.toString(), controlId: f.controlId?.toString() || null, severity: f.severity,
    description: f.description, source: f.source, status: f.status, ownerEmail: f.ownerEmail,
    compensatingControl: f.compensatingControl, closedAt: f.closedAt,
  };
}

export async function PATCH(req, { params }) {
  try {
    const { findingId } = await params;
    const body = await req.json();
    const { orgId, action } = body;
    if (!orgId || !action) return NextResponse.json({ error: "orgId and action are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "regulated");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await transitionFinding({ orgId, findingId, action, note: body.note, ownerEmail: body.ownerEmail, compensatingControl: body.compensatingControl, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ finding: serialize(result.finding) });
  } catch (err) {
    console.error("orgs/regulated/findings/[findingId]/transition PATCH failed:", err);
    return NextResponse.json({ error: "Could not update finding." }, { status: 500 });
  }
}
