// app/api/orgs/backup-schedules/route.js
// GET  ?orgId= -> list schedules with computed health
// POST { orgId, name, provider, credentialId, sourceBucket, sourcePrefix, destinationBucket, intervalHours } -> create

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../lib/orgs.js";
import { createBackupSchedule, listBackupSchedules, getScheduleHealth } from "../../../../lib/cloudBackupScheduler.js";

function serialize(s) {
  return {
    id: s._id.toString(), name: s.name, provider: s.provider, credentialId: s.credentialId.toString(),
    sourceBucket: s.sourceBucket, sourcePrefix: s.sourcePrefix, destinationBucket: s.destinationBucket,
    intervalHours: s.intervalHours, status: s.status, lastRunAt: s.lastRunAt, nextRunAt: s.nextRunAt,
    consecutiveFailures: s.consecutiveFailures, health: getScheduleHealth(s),
    createdByEmail: s.createdByEmail, createdAt: s.createdAt,
  };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const schedules = await listBackupSchedules(orgId);
    return NextResponse.json({ schedules: schedules.map(serialize) });
  } catch (err) {
    console.error("orgs/backup-schedules GET failed:", err);
    return NextResponse.json({ error: "Could not fetch backup schedules." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { orgId } = body;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await createBackupSchedule({ ...body, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ schedule: serialize(result.schedule) });
  } catch (err) {
    console.error("orgs/backup-schedules POST failed:", err);
    return NextResponse.json({ error: "Could not create this backup schedule." }, { status: 500 });
  }
}
