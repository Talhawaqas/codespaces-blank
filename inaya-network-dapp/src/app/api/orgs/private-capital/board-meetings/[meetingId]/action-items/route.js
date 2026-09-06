// app/api/orgs/private-capital/board-meetings/[meetingId]/action-items/route.js
// POST { orgId, description, ownerEmail?, dueDate? } -> append an action item (never silently removed, only completed)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../../lib/industry-config.js";
import { addActionItem } from "../../../../../../../lib/board-management.js";

export async function POST(req, { params }) {
  try {
    const { meetingId } = await params;
    const body = await req.json();
    const { orgId, description } = body;
    if (!orgId || !description) return NextResponse.json({ error: "orgId and description are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "private_capital");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await addActionItem({ ...body, meetingId, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ actionItems: result.meeting.actionItems });
  } catch (err) {
    console.error("orgs/private-capital/board-meetings/[meetingId]/action-items POST failed:", err);
    return NextResponse.json({ error: "Could not add action item." }, { status: 500 });
  }
}
