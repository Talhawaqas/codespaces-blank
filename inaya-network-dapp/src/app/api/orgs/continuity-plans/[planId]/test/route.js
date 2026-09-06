// app/api/orgs/continuity-plans/[planId]/test/route.js
// POST { orgId, result, notes?, evidenceDocumentId? } -> record a continuity test (append-only)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../lib/orgs.js";
import { recordContinuityTest } from "../../../../../../lib/business-continuity.js";

export async function POST(req, { params }) {
  try {
    const { planId } = await params;
    const body = await req.json();
    const { orgId, result: testResult } = body;
    if (!orgId || !testResult) return NextResponse.json({ error: "orgId and result are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await recordContinuityTest({ ...body, planId, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ testLog: result.plan.testLog });
  } catch (err) {
    console.error("orgs/continuity-plans/[planId]/test POST failed:", err);
    return NextResponse.json({ error: "Could not record continuity test." }, { status: 500 });
  }
}
