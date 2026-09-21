// app/api/orgs/storage/backup-policies/[policyId]/plans/route.js
// GET ?orgId= -> list plans for this policy; POST { orgId, frequency, retentionCount, priority } -> create a plan

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { createBackupPlan, listBackupPlans } from "../../../../../../../lib/storageBackupPolicies.js";

export async function GET(req, { params }) {
  try {
    const { policyId } = await params;
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await listBackupPlans({ orgId, policyId, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/storage/backup-policies/[policyId]/plans GET failed:", err);
    return NextResponse.json({ error: "Could not list backup plans." }, { status: 500 });
  }
}

export async function POST(req, { params }) {
  try {
    const { policyId } = await params;
    const body = await req.json().catch(() => ({}));
    const { orgId, frequency, retentionCount, priority } = body;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await createBackupPlan({ orgId, policyId, frequency, retentionCount, priority, membership: auth.membership, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ plan: { ...result.plan, _id: result.plan._id.toString() } });
  } catch (err) {
    console.error("orgs/storage/backup-policies/[policyId]/plans POST failed:", err);
    return NextResponse.json({ error: "Could not create backup plan." }, { status: 500 });
  }
}
