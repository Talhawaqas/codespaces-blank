// app/api/orgs/regulated/control-tests/route.js
// GET  ?orgId=&controlId= -> list control tests
// POST { orgId, controlId, method, result, testerEmail, evidenceIds, sample, findingSeverity } -> record a test (a "fail" auto-opens a Finding)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canAccessCompliance } from "../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../lib/industry-config.js";
import { recordControlTest, listControlTests } from "../../../../../lib/control-testing.js";

function serializeTest(t) {
  return { id: t._id.toString(), controlId: t.controlId.toString(), method: t.method, result: t.result, testerEmail: t.testerEmail, testedAt: t.testedAt, findingId: t.findingId?.toString() || null };
}
function serializeFinding(f) {
  return { id: f._id.toString(), controlId: f.controlId?.toString() || null, severity: f.severity, description: f.description, source: f.source, status: f.status };
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
    if (!canAccessCompliance(auth.membership)) return NextResponse.json({ error: "You don't have compliance access." }, { status: 403 });

    const tests = await listControlTests(orgId, { controlId: searchParams.get("controlId") || undefined });
    return NextResponse.json({ tests: tests.map(serializeTest) });
  } catch (err) {
    console.error("orgs/regulated/control-tests GET failed:", err);
    return NextResponse.json({ error: "Could not fetch control tests." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { orgId, controlId, method, result } = body;
    if (!orgId || !controlId || !method || !result) return NextResponse.json({ error: "orgId, controlId, method, and result are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "regulated");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const outcome = await recordControlTest({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (outcome.error) return NextResponse.json({ error: outcome.error }, { status: outcome.status });
    return NextResponse.json({ test: serializeTest(outcome.test), finding: outcome.finding ? serializeFinding(outcome.finding) : null });
  } catch (err) {
    console.error("orgs/regulated/control-tests POST failed:", err);
    return NextResponse.json({ error: "Could not record control test." }, { status: 500 });
  }
}
