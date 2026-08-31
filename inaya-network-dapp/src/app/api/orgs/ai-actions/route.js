// app/api/orgs/ai-actions/route.js
//
// GET /api/orgs/ai-actions?orgId=&status= — list AI action requests for
// this org. Any active member can see the list (it's no more sensitive
// than the underlying task/expense data it references) — approve/reject/
// cancel are the actions actually gated, in review/route.js and
// cancel/route.js.

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../lib/orgs.js";
import { listAiActionRequests } from "../../../../lib/ai-action-requests.js";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const status = searchParams.get("status") || undefined;
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const requests = await listAiActionRequests({ orgId, status });
    return NextResponse.json({
      requests: requests.map((r) => ({
        id: r._id.toString(), assistantSurface: r.assistantSurface, toolName: r.toolName,
        targetRecordType: r.targetRecordType, proposedAction: r.proposedAction,
        requestedContextSummary: r.requestedContextSummary, status: r.status,
        requestedByEmail: r.requestedByEmail, requestedAt: r.requestedAt,
        reviewedByEmail: r.reviewedByEmail, reviewedAt: r.reviewedAt, reviewNote: r.reviewNote,
        unlockAt: r.unlockAt, executedAt: r.executedAt, executionResult: r.executionResult,
      })),
    });
  } catch (err) {
    console.error("orgs/ai-actions GET failed:", err);
    return NextResponse.json({ error: "Could not load AI action requests." }, { status: 500 });
  }
}
