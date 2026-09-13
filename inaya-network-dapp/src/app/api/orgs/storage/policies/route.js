// app/api/orgs/storage/policies/route.js
//
// GET  /api/orgs/storage/policies?orgId=
// POST /api/orgs/storage/policies  { orgId, key, dataClassification, allowedRegions, preferredClusters, replicationRequirement }
// Versioned storage policy — Data Classification -> Storage Policy ->
// Allowed Regions -> Preferred Clusters -> Replication Requirements ->
// Applied Allocation. Each POST creates a NEW version under the same key
// (never edits a prior version in place), same convention as
// compliancePolicies.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canManageStorage, canAccessStorage } from "../../../../../lib/orgs.js";
import { createStoragePolicy, listStoragePolicies } from "../../../../../lib/storage-manager.js";

function serialize(p) {
  return {
    id: p._id.toString(), key: p.key, version: p.version, dataClassification: p.dataClassification,
    allowedRegions: p.allowedRegions, preferredClusters: p.preferredClusters, replicationRequirement: p.replicationRequirement,
    createdByEmail: p.createdByEmail, createdAt: p.createdAt,
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
    if (!canAccessStorage(auth.membership)) return NextResponse.json({ error: "You don't have storage-infrastructure access." }, { status: 403 });

    const policies = await listStoragePolicies(orgId);
    return NextResponse.json({ policies: policies.map(serialize) });
  } catch (err) {
    console.error("orgs/storage/policies GET failed:", err);
    return NextResponse.json({ error: "Could not fetch storage policies." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const { orgId, key, dataClassification, allowedRegions, preferredClusters, replicationRequirement } = await req.json();
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!canManageStorage(auth.membership)) return NextResponse.json({ error: "Only a storage manager can define a policy." }, { status: 403 });

    const result = await createStoragePolicy({ orgId, key, dataClassification, allowedRegions, preferredClusters, replicationRequirement, membership: auth.membership, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ policyId: result.policyId.toString(), version: result.version });
  } catch (err) {
    console.error("orgs/storage/policies POST failed:", err);
    return NextResponse.json({ error: "Could not create the storage policy." }, { status: 500 });
  }
}
