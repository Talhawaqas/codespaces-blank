// app/api/orgs/tasks/[taskId]/activity/route.js
//
// GET /api/orgs/tasks/:taskId/activity?orgId=...
// -> the task's history from org_activity, filtered to
//    {recordType:"TASK", recordId:taskId}, newest first.

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, canAccessDepartment, toObjectId } from "../../../../../../lib/orgs.js";
import { listOrgActivityForRecord } from "../../../../../../lib/org-activity-log.js";

export async function GET(req, { params }) {
  try {
    const { taskId } = params;
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { tasks } = await getOrgCollections();
    const task = await tasks.findOne({ _id: toObjectId(taskId), orgId: toObjectId(orgId) });
    if (!task) return NextResponse.json({ error: "Task not found." }, { status: 404 });
    if (!canAccessDepartment(auth.membership, task.departmentId)) {
      return NextResponse.json({ error: "Task not found." }, { status: 404 });
    }

    const events = await listOrgActivityForRecord({ orgId, recordType: "TASK", recordId: taskId });
    return NextResponse.json({
      activity: events.map((e) => ({
        eventId: e.eventId,
        actorEmail: e.actorEmail,
        action: e.action,
        previousState: e.previousState,
        newState: e.newState,
        metadata: e.metadata || {},
        timestamp: e.timestamp,
      })),
    });
  } catch (err) {
    console.error("orgs/tasks/[taskId]/activity failed:", err);
    return NextResponse.json({ error: "Could not fetch task activity." }, { status: 500 });
  }
}
