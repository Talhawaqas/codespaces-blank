// app/api/orgs/risk-register/route.js
// GET   ?orgId=&status= -> list risks
// POST  { orgId, category, severity, likelihood, impact, ... } -> add a risk
// PATCH { orgId, riskId, status } -> update status

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../lib/orgs.js";
import { createRisk, updateRiskStatus, listRisks } from "../../../../lib/risk-register.js";

function serialize(r) {
  return { id: r._id.toString(), category: r.category, severity: r.severity, status: r.status, reviewDate: r.reviewDate, mitigation: r.mitigation };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const status = searchParams.get("status");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const risks = await listRisks(orgId, { status });
    return NextResponse.json({ risks: risks.map(serialize) });
  } catch (err) {
    console.error("orgs/risk-register GET failed:", err);
    return NextResponse.json({ error: "Could not fetch risk register." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    if (!body.orgId || !body.category || !body.severity) return NextResponse.json({ error: "orgId, category, and severity are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, body.orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await createRisk({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ risk: serialize(result.risk) });
  } catch (err) {
    console.error("orgs/risk-register POST failed:", err);
    return NextResponse.json({ error: "Could not add risk entry." }, { status: 500 });
  }
}

export async function PATCH(req) {
  try {
    const { orgId, riskId, status } = await req.json();
    if (!orgId || !riskId || !status) return NextResponse.json({ error: "orgId, riskId, and status are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await updateRiskStatus({ orgId, riskId, status, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ risk: serialize(result.risk) });
  } catch (err) {
    console.error("orgs/risk-register PATCH failed:", err);
    return NextResponse.json({ error: "Could not update risk entry." }, { status: 500 });
  }
}
