// app/api/orgs/backup-schedules/[scheduleId]/run/route.js
// POST { orgId } -> run this schedule right now (real transfer, not a preview)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../lib/orgs.js";
import { runBackupJob } from "../../../../../../lib/cloudBackupScheduler.js";

export async function POST(req, { params }) {
  try {
    const { scheduleId } = await params;
    const body = await req.json().catch(() => ({}));
    const { orgId } = body;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await runBackupJob({ orgId, scheduleId, actorEmail: auth.session.email });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ run: { ...result.run, _id: result.run._id.toString() } });
  } catch (err) {
    console.error("orgs/backup-schedules/[scheduleId]/run POST failed:", err);
    return NextResponse.json({ error: "Could not run this backup schedule." }, { status: 500 });
  }
}
