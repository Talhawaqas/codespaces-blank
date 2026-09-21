// app/api/orgs/storage/backup-plans/[planId]/run/route.js
// POST { orgId } -> run this plan now (real transfer, not a preview)
//
// runBackupPolicyPlan() itself takes no membership param by design (see its
// own doc comment) -- this route is the one place that authorizes the
// action before calling it.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, canManageStorage } from "../../../../../../../lib/orgs.js";
import { runBackupPolicyPlan } from "../../../../../../../lib/storageBackupPolicies.js";

export async function POST(req, { params }) {
  try {
    const { planId } = await params;
    const body = await req.json().catch(() => ({}));
    const { orgId } = body;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    if (!canManageStorage(auth.membership)) return NextResponse.json({ error: "Only a storage manager can run a backup plan." }, { status: 403 });

    const result = await runBackupPolicyPlan({ orgId, planId, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/storage/backup-plans/[planId]/run POST failed:", err);
    return NextResponse.json({ error: "Could not run backup plan." }, { status: 500 });
  }
}
