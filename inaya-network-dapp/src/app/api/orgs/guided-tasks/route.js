// app/api/orgs/guided-tasks/route.js
//
// POST /api/orgs/guided-tasks — start a new guided task. Body: { orgId, workflowKey }
// GET  /api/orgs/guided-tasks?orgId= — list this user's active/paused guided tasks
//      (used for a "resume where you left off?" banner on page load).

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../lib/orgs.js";
import { startGuidedTask, listActiveGuidedTasksForUser } from "../../../../lib/guided-tasks.js";
import { getGuidedWorkflow } from "../../../../lib/guided-workflow-catalog.js";

export async function POST(req) {
  try {
    const { orgId, workflowKey, currentView } = await req.json();
    if (!orgId || !workflowKey) return NextResponse.json({ error: "orgId and workflowKey are required." }, { status: 400 });
    if (!getGuidedWorkflow(workflowKey)) return NextResponse.json({ error: `Unknown workflow "${workflowKey}".` }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await startGuidedTask({ orgId, userEmail: auth.session.email, workflowKey, context: currentView ? { currentView } : {} });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });

    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/guided-tasks POST failed:", err);
    return NextResponse.json({ error: "Could not start the guided task." }, { status: 500 });
  }
}

export async function GET(req) {
  try {
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await listActiveGuidedTasksForUser({ orgId, userEmail: auth.session.email });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/guided-tasks GET failed:", err);
    return NextResponse.json({ error: "Could not load guided tasks." }, { status: 500 });
  }
}
