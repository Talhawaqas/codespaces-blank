// app/api/orgs/backup-schedules/[scheduleId]/route.js
// PATCH { orgId, action } -> action: "pause" | "resume" | "delete"

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { pauseBackupSchedule, resumeBackupSchedule, deleteBackupSchedule } from "../../../../../lib/cloudBackupScheduler.js";

export async function PATCH(req, { params }) {
  try {
    const { scheduleId } = await params;
    const body = await req.json();
    const { orgId, action } = body;
    if (!orgId || !action) return NextResponse.json({ error: "orgId and action are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const ctx = { orgId, scheduleId, actorEmail: auth.session.email, membership: auth.membership };
    let result;
    if (action === "pause") result = await pauseBackupSchedule(ctx);
    else if (action === "resume") result = await resumeBackupSchedule(ctx);
    else if (action === "delete") result = await deleteBackupSchedule(ctx);
    else return NextResponse.json({ error: `Unknown action "${action}".` }, { status: 400 });

    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/backup-schedules/[scheduleId] PATCH failed:", err);
    return NextResponse.json({ error: "Could not update this backup schedule." }, { status: 500 });
  }
}
