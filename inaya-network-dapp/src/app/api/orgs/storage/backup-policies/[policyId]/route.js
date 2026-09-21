// app/api/orgs/storage/backup-policies/[policyId]/route.js
// PATCH { orgId, enabled } -> pause/resume a policy

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../lib/orgs.js";
import { setBackupPolicyEnabled } from "../../../../../../lib/storageBackupPolicies.js";

export async function PATCH(req, { params }) {
  try {
    const { policyId } = await params;
    const body = await req.json().catch(() => ({}));
    const { orgId, enabled } = body;
    if (!orgId || typeof enabled !== "boolean") return NextResponse.json({ error: "orgId and a boolean enabled are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await setBackupPolicyEnabled({ orgId, policyId, enabled, membership: auth.membership, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/storage/backup-policies/[policyId] PATCH failed:", err);
    return NextResponse.json({ error: "Could not update backup policy." }, { status: 500 });
  }
}
