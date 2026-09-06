// app/api/orgs/dr-runbooks/[runbookId]/test/route.js
// GET  ?orgId= -> list DR test history for this runbook
// POST { orgId, result, findings?, remediation?, retestRequired? } -> record a DR test (immutable)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../lib/orgs.js";
import { recordDrTest, listDrTests } from "../../../../../../lib/disaster-recovery.js";

function serialize(t) {
  return { id: t._id.toString(), result: t.result, findings: t.findings, remediation: t.remediation, retestRequired: t.retestRequired, testedByEmail: t.testedByEmail, testedAt: t.testedAt };
}

export async function GET(req, { params }) {
  try {
    const { runbookId } = await params;
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const tests = await listDrTests(orgId, { runbookId });
    return NextResponse.json({ tests: tests.map(serialize) });
  } catch (err) {
    console.error("orgs/dr-runbooks/[runbookId]/test GET failed:", err);
    return NextResponse.json({ error: "Could not fetch DR test history." }, { status: 500 });
  }
}

export async function POST(req, { params }) {
  try {
    const { runbookId } = await params;
    const body = await req.json();
    const { orgId, result: testResult } = body;
    if (!orgId || !testResult) return NextResponse.json({ error: "orgId and result are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await recordDrTest({ ...body, runbookId, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ test: serialize(result.test) });
  } catch (err) {
    console.error("orgs/dr-runbooks/[runbookId]/test POST failed:", err);
    return NextResponse.json({ error: "Could not record DR test." }, { status: 500 });
  }
}
