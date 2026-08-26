// app/api/orgs/tasks/[taskId]/transition/route.js
//
// POST /api/orgs/tasks/:taskId/transition
// Body: { orgId, action, note? }
// action is one of: start, block, resume, complete, reopen, cancel
//
// The ONLY place task status changes happen — see src/lib/task-workflow.js
// for the actual state machine, permission enforcement, org isolation, and
// atomicity/replay-safety. Thin by design, same shape as
// documents/[documentId]/transition/route.js.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../lib/orgs.js";
import { transitionTask } from "../../../../../../lib/task-workflow.js";

export async function POST(req, { params }) {
  try {
    const { taskId } = params;
    const { orgId, action, note } = await req.json();
    if (!orgId || !action) {
      return NextResponse.json({ error: "orgId and action are required." }, { status: 400 });
    }

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await transitionTask({
      orgId,
      taskId,
      action,
      membership: auth.membership,
      actorEmail: auth.session.email,
      note,
    });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });

    return NextResponse.json({
      status: result.task.status,
      updatedAt: result.task.updatedAt,
      completedAt: result.task.completedAt || null,
    });
  } catch (err) {
    console.error("orgs/tasks/[taskId]/transition failed:", err);
    return NextResponse.json({ error: "Could not update the task's status." }, { status: 500 });
  }
}
