// app/api/orgs/resilience-tests/route.js
// GET  ?orgId=&testType=&result= -> list resilience tests, plus which test types have never been run
// POST { orgId, testType, scope, result, ... } -> record a resilience test (immutable)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../lib/orgs.js";
import { recordResilienceTest, listResilienceTests, listUncoveredTestTypes } from "../../../../lib/resilience-testing.js";

function serialize(t) {
  return { id: t._id.toString(), testType: t.testType, scope: t.scope, testerEmail: t.testerEmail, methodology: t.methodology, result: t.result, findings: t.findings, remediation: t.remediation, retestRequired: t.retestRequired, testedAt: t.testedAt };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const [tests, uncoveredTestTypes] = await Promise.all([
      listResilienceTests(orgId, { testType: searchParams.get("testType") || undefined, result: searchParams.get("result") || undefined }),
      listUncoveredTestTypes(orgId),
    ]);
    return NextResponse.json({ tests: tests.map(serialize), uncoveredTestTypes });
  } catch (err) {
    console.error("orgs/resilience-tests GET failed:", err);
    return NextResponse.json({ error: "Could not fetch resilience tests." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { orgId, testType, scope, result: testResult } = body;
    if (!orgId || !testType || !scope || !testResult) return NextResponse.json({ error: "orgId, testType, scope, and result are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await recordResilienceTest({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ test: serialize(result.test) });
  } catch (err) {
    console.error("orgs/resilience-tests POST failed:", err);
    return NextResponse.json({ error: "Could not record resilience test." }, { status: 500 });
  }
}
