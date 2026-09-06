// app/api/orgs/regulated/audits/route.js
// GET  ?orgId=&status= -> list internal audit plans
// POST { orgId, name, scope, universe, program, line, leadAuditorEmail } -> create an audit plan

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessAudit } from "../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../lib/industry-config.js";
import { createAuditPlan, listAuditPlans } from "../../../../../lib/internal-audit.js";

function serialize(p) {
  return {
    id: p._id.toString(), name: p.name, scope: p.scope, universe: p.universe, program: p.program,
    line: p.line, leadAuditorEmail: p.leadAuditorEmail, status: p.status,
    findingIds: (p.findingIds || []).map((id) => id.toString()), auditReport: p.auditReport,
  };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "regulated");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });
    if (!canAccessAudit(auth.membership)) return NextResponse.json({ error: "You don't have audit access." }, { status: 403 });

    const plans = await listAuditPlans(orgId, { status: searchParams.get("status") || undefined });
    return NextResponse.json({ auditPlans: plans.map(serialize) });
  } catch (err) {
    console.error("orgs/regulated/audits GET failed:", err);
    return NextResponse.json({ error: "Could not fetch audit plans." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { orgId, name } = body;
    if (!orgId || !name) return NextResponse.json({ error: "orgId and name are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "regulated");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await createAuditPlan({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ auditPlan: serialize(result.auditPlan) });
  } catch (err) {
    console.error("orgs/regulated/audits POST failed:", err);
    return NextResponse.json({ error: "Could not create audit plan." }, { status: 500 });
  }
}
