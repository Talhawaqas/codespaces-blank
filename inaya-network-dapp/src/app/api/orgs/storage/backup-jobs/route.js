// app/api/orgs/storage/backup-jobs/route.js
// GET ?orgId=&policyId=&planId= -> job history, most recent first

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { listBackupJobs } from "../../../../../lib/storageBackupPolicies.js";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await listBackupJobs({
      orgId,
      policyId: searchParams.get("policyId") || undefined,
      planId: searchParams.get("planId") || undefined,
      membership: auth.membership,
      limit: Number(searchParams.get("limit")) || 50,
    });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/storage/backup-jobs GET failed:", err);
    return NextResponse.json({ error: "Could not list backup jobs." }, { status: 500 });
  }
}
