// app/api/orgs/board-reports/[reportId]/publish/route.js
// POST { orgId } -> publish a DRAFT board report (the only path to PUBLISHED; immutable after)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../lib/orgs.js";
import { publishBoardReport } from "../../../../../../lib/board-reporting.js";

export async function POST(req, { params }) {
  try {
    const { reportId } = await params;
    const { orgId } = await req.json();
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await publishBoardReport({ orgId, reportId, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ report: { id: result.report._id.toString(), status: result.report.status, publishedAt: result.report.publishedAt } });
  } catch (err) {
    console.error("orgs/board-reports/[reportId]/publish POST failed:", err);
    return NextResponse.json({ error: "Could not publish the board report." }, { status: 500 });
  }
}
