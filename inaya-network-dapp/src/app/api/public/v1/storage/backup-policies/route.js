// app/api/public/v1/storage/backup-policies/route.js
//
// Authorization: Bearer <apiKey>. GET -> list; POST
// { name, tagSelector, notificationPolicy } -> create.

import { NextResponse } from "next/server";
import { ensureOrgIndexes } from "../../../../../../lib/orgs.js";
import { requireApiKey } from "../../../../../../lib/api-keys.js";
import { createBackupPolicy, listBackupPolicies } from "../../../../../../lib/storageBackupPolicies.js";

export async function GET(req) {
  try {
    await ensureOrgIndexes();
    const auth = await requireApiKey(req);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await listBackupPolicies({ orgId: auth.orgId, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("public/v1/storage/backup-policies GET failed:", err);
    return NextResponse.json({ error: "Could not list backup policies." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    await ensureOrgIndexes();
    const auth = await requireApiKey(req);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const body = await req.json().catch(() => ({}));
    const { name, tagSelector, notificationPolicy } = body;
    const result = await createBackupPolicy({ orgId: auth.orgId, name, tagSelector, notificationPolicy, membership: auth.membership, actorEmail: "terraform-provider-inaya" });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ policy: { ...result.policy, _id: result.policy._id.toString() } });
  } catch (err) {
    console.error("public/v1/storage/backup-policies POST failed:", err);
    return NextResponse.json({ error: "Could not create backup policy." }, { status: 500 });
  }
}
