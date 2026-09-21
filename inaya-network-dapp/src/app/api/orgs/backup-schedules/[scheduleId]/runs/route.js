// app/api/orgs/backup-schedules/[scheduleId]/runs/route.js
// GET ?orgId=&limit= -> run history for this schedule, most recent first

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership, toObjectId, getOrgCollections } from "../../../../../../lib/orgs.js";

export async function GET(req, { params }) {
  try {
    const { scheduleId } = await params;
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { backupRuns } = await getOrgCollections();
    const limit = Math.min(Number(searchParams.get("limit")) || 20, 100);
    const runs = await backupRuns.find({ scheduleId: toObjectId(scheduleId), orgId: toObjectId(orgId) }).sort({ startedAt: -1 }).limit(limit).toArray();

    return NextResponse.json({
      runs: runs.map((r) => ({
        id: r._id.toString(), startedAt: r.startedAt, completedAt: r.completedAt, status: r.status,
        objectsSeen: r.objectsSeen, objectsChanged: r.objectsChanged, objectsCopied: r.objectsCopied,
        objectsVerified: r.objectsVerified, verificationFailures: r.verificationFailures, bytesTransferred: r.bytesTransferred,
        errorSummary: r.errorSummary,
      })),
    });
  } catch (err) {
    console.error("orgs/backup-schedules/[scheduleId]/runs GET failed:", err);
    return NextResponse.json({ error: "Could not fetch run history." }, { status: 500 });
  }
}
