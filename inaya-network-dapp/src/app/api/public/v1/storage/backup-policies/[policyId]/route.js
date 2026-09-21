// app/api/public/v1/storage/backup-policies/[policyId]/route.js
//
// Authorization: Bearer <apiKey>. GET -> detail; PATCH { enabled } -> pause/resume;
// DELETE -> soft delete (see storageBackupPolicies.js's deleteBackupPolicy()).

import { NextResponse } from "next/server";
import { ensureOrgIndexes } from "../../../../../../../lib/orgs.js";
import { requireApiKey } from "../../../../../../../lib/api-keys.js";
import { getBackupPolicy, setBackupPolicyEnabled, deleteBackupPolicy } from "../../../../../../../lib/storageBackupPolicies.js";

export async function GET(req, { params }) {
  try {
    const { policyId } = await params;
    await ensureOrgIndexes();
    const auth = await requireApiKey(req);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await getBackupPolicy({ orgId: auth.orgId, policyId, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("public/v1/storage/backup-policies/[policyId] GET failed:", err);
    return NextResponse.json({ error: "Could not fetch backup policy." }, { status: 500 });
  }
}

export async function PATCH(req, { params }) {
  try {
    const { policyId } = await params;
    await ensureOrgIndexes();
    const auth = await requireApiKey(req);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const body = await req.json().catch(() => ({}));
    const result = await setBackupPolicyEnabled({ orgId: auth.orgId, policyId, enabled: body.enabled, membership: auth.membership, actorEmail: "terraform-provider-inaya" });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("public/v1/storage/backup-policies/[policyId] PATCH failed:", err);
    return NextResponse.json({ error: "Could not update backup policy." }, { status: 500 });
  }
}

export async function DELETE(req, { params }) {
  try {
    const { policyId } = await params;
    await ensureOrgIndexes();
    const auth = await requireApiKey(req);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await deleteBackupPolicy({ orgId: auth.orgId, policyId, membership: auth.membership, actorEmail: "terraform-provider-inaya" });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("public/v1/storage/backup-policies/[policyId] DELETE failed:", err);
    return NextResponse.json({ error: "Could not delete backup policy." }, { status: 500 });
  }
}
