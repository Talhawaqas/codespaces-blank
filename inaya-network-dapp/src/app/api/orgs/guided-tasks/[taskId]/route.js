// app/api/orgs/guided-tasks/[taskId]/route.js
//
// GET   /api/orgs/guided-tasks/:taskId?orgId= — current state (poll/resume)
// PATCH /api/orgs/guided-tasks/:taskId — body: { orgId, action: "pause"|"resume"|"cancel"|"restart" }
//
// One file for pause/resume/cancel/restart since all four share the exact
// same orgId+userEmail gate (unlike e.g. ai-action-requests.js's review
// vs. cancel routes, which genuinely need different auth checks).

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../lib/orgs.js";
import { getGuidedTask, pauseGuidedTask, resumeGuidedTask, cancelGuidedTask, restartGuidedTask } from "../../../../../lib/guided-tasks.js";

const ACTIONS = {
  pause: pauseGuidedTask,
  resume: resumeGuidedTask,
  cancel: cancelGuidedTask,
  restart: restartGuidedTask,
};

export async function GET(req, { params }) {
  try {
    const { taskId } = params;
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await getGuidedTask({ orgId, userEmail: auth.session.email, taskId });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/guided-tasks/[taskId] GET failed:", err);
    return NextResponse.json({ error: "Could not load the guided task." }, { status: 500 });
  }
}

export async function PATCH(req, { params }) {
  try {
    const { taskId } = params;
    const { orgId, action } = await req.json();
    if (!orgId || !action) return NextResponse.json({ error: "orgId and action are required." }, { status: 400 });
    const impl = ACTIONS[action];
    if (!impl) return NextResponse.json({ error: `Unknown action "${action}". Valid actions: ${Object.keys(ACTIONS).join(", ")}.` }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await impl({ orgId, userEmail: auth.session.email, taskId });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/guided-tasks/[taskId] PATCH failed:", err);
    return NextResponse.json({ error: "Could not update the guided task." }, { status: 500 });
  }
}
