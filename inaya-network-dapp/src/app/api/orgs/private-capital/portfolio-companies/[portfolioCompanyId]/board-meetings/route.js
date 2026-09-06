// app/api/orgs/private-capital/portfolio-companies/[portfolioCompanyId]/board-meetings/route.js
// GET  ?orgId= -> list board meetings for this company (elevated permission required)
// POST { orgId, scheduledAt } -> schedule a new board meeting

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../../lib/industry-config.js";
import { createBoardMeeting, listBoardMeetings } from "../../../../../../../lib/board-management.js";

function serialize(m) {
  return { id: m._id.toString(), portfolioCompanyId: m.portfolioCompanyId.toString(), scheduledAt: m.scheduledAt, agenda: m.agenda, attendees: m.attendees, minutesText: m.minutesText, actionItems: m.actionItems, conflicts: m.conflicts, status: m.status };
}

export async function GET(req, { params }) {
  try {
    const { portfolioCompanyId } = await params;
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "private_capital");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await listBoardMeetings(orgId, portfolioCompanyId, auth.membership);
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ meetings: result.meetings.map(serialize) });
  } catch (err) {
    console.error("orgs/private-capital/portfolio-companies/[id]/board-meetings GET failed:", err);
    return NextResponse.json({ error: "Could not fetch board meetings." }, { status: 500 });
  }
}

export async function POST(req, { params }) {
  try {
    const { portfolioCompanyId } = await params;
    const body = await req.json();
    const { orgId, scheduledAt } = body;
    if (!orgId || !scheduledAt) return NextResponse.json({ error: "orgId and scheduledAt are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "private_capital");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await createBoardMeeting({ orgId, portfolioCompanyId, scheduledAt, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ meeting: serialize(result.meeting) });
  } catch (err) {
    console.error("orgs/private-capital/portfolio-companies/[id]/board-meetings POST failed:", err);
    return NextResponse.json({ error: "Could not create board meeting." }, { status: 500 });
  }
}
