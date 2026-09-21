// app/api/orgs/storage/backup-policies/route.js
// GET ?orgId= -> list; POST { orgId, name, tagSelector, notificationPolicy } -> create

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { createBackupPolicy, listBackupPolicies } from "../../../../../lib/storageBackupPolicies.js";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await listBackupPolicies({ orgId, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/storage/backup-policies GET failed:", err);
    return NextResponse.json({ error: "Could not list backup policies." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const { orgId, name, tagSelector, notificationPolicy } = body;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await createBackupPolicy({ orgId, name, tagSelector, notificationPolicy, membership: auth.membership, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ policy: { ...result.policy, _id: result.policy._id.toString() } });
  } catch (err) {
    console.error("orgs/storage/backup-policies POST failed:", err);
    return NextResponse.json({ error: "Could not create backup policy." }, { status: 500 });
  }
}
