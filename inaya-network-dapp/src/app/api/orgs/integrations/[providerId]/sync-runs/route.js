// app/api/orgs/integrations/[providerId]/sync-runs/route.js
// GET  ?orgId=&limit= -> reconciliation history for this provider
// POST { orgId, result, sourceCount, targetCount, newCount, updatedCount, deletedCount, failedCount, conflicts, errorMessage }
//      -> record a real sync attempt's outcome (the only path to ACTIVE/ERROR)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../lib/orgs.js";
import { listSyncRuns, recordSyncRun } from "../../../../../../lib/integrations.js";

function serialize(r) {
  return {
    id: r._id.toString(), providerId: r.providerId, result: r.result,
    sourceCount: r.sourceCount, targetCount: r.targetCount, newCount: r.newCount,
    updatedCount: r.updatedCount, deletedCount: r.deletedCount, failedCount: r.failedCount,
    conflicts: r.conflicts, errorMessage: r.errorMessage, startedAt: r.startedAt, completedAt: r.completedAt,
  };
}

export async function GET(req, { params }) {
  try {
    const { providerId } = await params;
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const limit = Number(searchParams.get("limit")) || 20;
    const runs = await listSyncRuns(orgId, { providerId, limit });
    return NextResponse.json({ runs: runs.map(serialize) });
  } catch (err) {
    console.error("orgs/integrations/[providerId]/sync-runs GET failed:", err);
    return NextResponse.json({ error: "Could not fetch sync history." }, { status: 500 });
  }
}

export async function POST(req, { params }) {
  try {
    const { providerId } = await params;
    const body = await req.json();
    const { orgId, result } = body;
    if (!orgId || !result) return NextResponse.json({ error: "orgId and result are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const outcome = await recordSyncRun({ ...body, providerId, actorEmail: auth.session.email });
    if (outcome.error) return NextResponse.json({ error: outcome.error }, { status: outcome.status });
    return NextResponse.json({ run: serialize(outcome.run), connection: outcome.connection });
  } catch (err) {
    console.error("orgs/integrations/[providerId]/sync-runs POST failed:", err);
    return NextResponse.json({ error: "Could not record sync run." }, { status: 500 });
  }
}
