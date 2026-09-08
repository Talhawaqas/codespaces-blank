// app/api/orgs/guided-tasks/[taskId]/step-complete/route.js
//
// POST /api/orgs/guided-tasks/:taskId/step-complete
// Body: { orgId, fromStepIndex, source }  (source: "manual-confirm" | "client-event")
//
// Deliberately NOT an LLM round trip — a client-detected completion (a nav
// event, or the "I did this" button) just needs the next catalog-authored
// step handed back immediately. Round-tripping Gemini on every single
// click confirmation across a 5-8 step workflow would be slow and wasteful
// (business-chat/route.js's own MAX_TOOL_ROUNDS/SAFETY_BUDGET_MS exist
// precisely because each Gemini call is a real, non-trivial cost) — only
// the initial "start" (intent -> workflow selection) and mid-flow
// questions go through the chat loop.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../lib/orgs.js";
import { advanceGuidedTaskStep } from "../../../../../../lib/guided-tasks.js";

export async function POST(req, { params }) {
  try {
    const { taskId } = params;
    const { orgId, fromStepIndex, source } = await req.json();
    if (!orgId || !Number.isInteger(fromStepIndex)) {
      return NextResponse.json({ error: "orgId and an integer fromStepIndex are required." }, { status: 400 });
    }

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await advanceGuidedTaskStep({ orgId, userEmail: auth.session.email, taskId, fromStepIndex, source: source || "client-event" });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/guided-tasks/[taskId]/step-complete failed:", err);
    return NextResponse.json({ error: "Could not advance the guided task." }, { status: 500 });
  }
}
