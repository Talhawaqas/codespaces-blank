// app/api/orgs/board-reports/route.js
// GET  ?orgId=&status= -> list board reports
// POST { orgId } -> draft a new board report (real aggregated data, not yet official)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../lib/orgs.js";
import { draftBoardReport, listBoardReports } from "../../../../lib/board-reporting.js";

function serialize(r) {
  return { id: r._id.toString(), status: r.status, vertical: r.vertical, sections: r.sections, draftedByEmail: r.draftedByEmail, draftedAt: r.draftedAt, publishedByEmail: r.publishedByEmail, publishedAt: r.publishedAt };
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const reports = await listBoardReports(orgId, { status: searchParams.get("status") || undefined });
    return NextResponse.json({ reports: reports.map(serialize) });
  } catch (err) {
    console.error("orgs/board-reports GET failed:", err);
    return NextResponse.json({ error: "Could not fetch board reports." }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const { orgId } = await req.json();
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const result = await draftBoardReport({ orgId, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ report: serialize(result.report) });
  } catch (err) {
    console.error("orgs/board-reports POST failed:", err);
    return NextResponse.json({ error: "Could not draft a board report." }, { status: 500 });
  }
}
