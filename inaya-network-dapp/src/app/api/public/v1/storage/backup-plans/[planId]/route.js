// app/api/public/v1/storage/backup-plans/[planId]/route.js
//
// Authorization: Bearer <apiKey>. GET -> detail; DELETE -> soft delete
// (see storageBackupPolicies.js's deleteBackupPlan()).

import { NextResponse } from "next/server";
import { ensureOrgIndexes } from "../../../../../../../lib/orgs.js";
import { requireApiKey } from "../../../../../../../lib/api-keys.js";
import { getBackupPlan, deleteBackupPlan } from "../../../../../../../lib/storageBackupPolicies.js";

export async function GET(req, { params }) {
  try {
    const { planId } = await params;
    await ensureOrgIndexes();
    const auth = await requireApiKey(req);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await getBackupPlan({ orgId: auth.orgId, planId, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("public/v1/storage/backup-plans/[planId] GET failed:", err);
    return NextResponse.json({ error: "Could not fetch backup plan." }, { status: 500 });
  }
}

export async function DELETE(req, { params }) {
  try {
    const { planId } = await params;
    await ensureOrgIndexes();
    const auth = await requireApiKey(req);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await deleteBackupPlan({ orgId: auth.orgId, planId, membership: auth.membership, actorEmail: "terraform-provider-inaya" });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("public/v1/storage/backup-plans/[planId] DELETE failed:", err);
    return NextResponse.json({ error: "Could not delete backup plan." }, { status: 500 });
  }
}
