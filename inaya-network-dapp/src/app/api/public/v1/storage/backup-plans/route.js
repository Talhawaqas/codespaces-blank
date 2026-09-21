// app/api/public/v1/storage/backup-plans/route.js
//
// Authorization: Bearer <apiKey>. GET ?policyId= -> list; POST
// { policyId, frequency, retentionCount, priority } -> create.

import { NextResponse } from "next/server";
import { ensureOrgIndexes } from "../../../../../../lib/orgs.js";
import { requireApiKey } from "../../../../../../lib/api-keys.js";
import { createBackupPlan, listBackupPlans } from "../../../../../../lib/storageBackupPolicies.js";

export async function GET(req) {
  try {
    await ensureOrgIndexes();
    const auth = await requireApiKey(req);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { searchParams } = new URL(req.url);
    const policyId = searchParams.get("policyId") || undefined;
    const result = await listBackupPlans({ orgId: auth.orgId, policyId, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("public/v1/storage/backup-plans GET failed:", err);
    return NextResponse.json({ error: "Could not list backup plans." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    await ensureOrgIndexes();
    const auth = await requireApiKey(req);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const body = await req.json().catch(() => ({}));
    const { policyId, frequency, retentionCount, priority } = body;
    const result = await createBackupPlan({ orgId: auth.orgId, policyId, frequency, retentionCount, priority, membership: auth.membership, actorEmail: "terraform-provider-inaya" });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ plan: { ...result.plan, _id: result.plan._id.toString(), policyId: result.plan.policyId.toString() } });
  } catch (err) {
    console.error("public/v1/storage/backup-plans POST failed:", err);
    return NextResponse.json({ error: "Could not create backup plan." }, { status: 500 });
  }
}
