// app/api/orgs/regulated/audits/[auditId]/findings/route.js
// POST { orgId, controlId?, severity, description } -> record a finding discovered during this audit

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../../lib/industry-config.js";
import { recordAuditFinding } from "../../../../../../../lib/internal-audit.js";

function serialize(f) {
  return { id: f._id.toString(), controlId: f.controlId?.toString() || null, severity: f.severity, description: f.description, source: f.source, status: f.status };
}

export async function POST(req, { params }) {
  try {
    const { auditId } = await params;
    const body = await req.json();
    const { orgId, description } = body;
    if (!orgId || !description) return NextResponse.json({ error: "orgId and description are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "regulated");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await recordAuditFinding({ orgId, auditPlanId: auditId, controlId: body.controlId, severity: body.severity, description, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ finding: serialize(result.finding) });
  } catch (err) {
    console.error("orgs/regulated/audits/[auditId]/findings POST failed:", err);
    return NextResponse.json({ error: "Could not record audit finding." }, { status: 500 });
  }
}
