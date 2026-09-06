// app/api/orgs/private-capital/board-meetings/[meetingId]/conflicts/route.js
// POST { orgId, memberEmail, description } -> record a conflict of interest disclosure (append-only)

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../../lib/industry-config.js";
import { recordConflict } from "../../../../../../../lib/board-management.js";

export async function POST(req, { params }) {
  try {
    const { meetingId } = await params;
    const body = await req.json();
    const { orgId, memberEmail, description } = body;
    if (!orgId || !memberEmail || !description) return NextResponse.json({ error: "orgId, memberEmail, and description are required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "private_capital");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await recordConflict({ orgId, meetingId, memberEmail, description, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ conflicts: result.meeting.conflicts });
  } catch (err) {
    console.error("orgs/private-capital/board-meetings/[meetingId]/conflicts POST failed:", err);
    return NextResponse.json({ error: "Could not record conflict." }, { status: 500 });
  }
}
