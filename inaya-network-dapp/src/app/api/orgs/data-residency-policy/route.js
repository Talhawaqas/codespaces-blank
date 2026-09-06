// app/api/orgs/data-residency-policy/route.js
// GET   ?orgId= -> the org's declared data residency policy
// POST  { orgId, country?, region?, ... } -> create/update the policy (one per org, upsert)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../lib/orgs.js";
import { getDataResidencyPolicy, upsertDataResidencyPolicy } from "../../../../lib/data-residency.js";

function serialize(p) {
  if (!p) return null;
  return {
    country: p.country, region: p.region, storageProvider: p.storageProvider, backupProvider: p.backupProvider,
    encryptionPolicy: p.encryptionPolicy, keyManagementPolicy: p.keyManagementPolicy,
    processingRestrictions: p.processingRestrictions, externalTransferRules: p.externalTransferRules, updatedAt: p.updatedAt,
  };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const policy = await getDataResidencyPolicy(orgId);
    return NextResponse.json({ policy: serialize(policy) });
  } catch (err) {
    console.error("orgs/data-residency-policy GET failed:", err);
    return NextResponse.json({ error: "Could not fetch data residency policy." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { orgId } = body;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await upsertDataResidencyPolicy({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ policy: serialize(result.policy) });
  } catch (err) {
    console.error("orgs/data-residency-policy POST failed:", err);
    return NextResponse.json({ error: "Could not update data residency policy." }, { status: 500 });
  }
}
