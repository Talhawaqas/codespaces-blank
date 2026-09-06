// app/api/orgs/regulated/audits/[auditId]/transition/route.js
// PATCH { orgId, action, auditReport? } -> startFieldwork / startReporting / close

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../../lib/industry-config.js";
import { transitionAuditPlan } from "../../../../../../../lib/internal-audit.js";

function serialize(p) {
  return { id: p._id.toString(), name: p.name, status: p.status, findingIds: (p.findingIds || []).map((id) => id.toString()), auditReport: p.auditReport };
}

export async function PATCH(req, { params }) {
  try {
    const { auditId } = await params;
    const { orgId, action, auditReport } = await req.json();
    if (!orgId || !action) return NextResponse.json({ error: "orgId and action are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "regulated");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await transitionAuditPlan({ orgId, auditPlanId: auditId, action, auditReport, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ auditPlan: serialize(result.auditPlan) });
  } catch (err) {
    console.error("orgs/regulated/audits/[auditId]/transition PATCH failed:", err);
    return NextResponse.json({ error: "Could not update audit plan." }, { status: 500 });
  }
}
