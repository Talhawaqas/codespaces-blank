// app/api/orgs/private-capital/board-meetings/[meetingId]/route.js
// PATCH { orgId, action, agendaItems? | attendees? | minutesText? } -> setAgenda / hold / draftMinutes / approveMinutes

import { NextResponse } from "next/server";
import { ensureOrgIndexes, requireMembership } from "../../../../../../lib/orgs.js";
import { requireVertical } from "../../../../../../lib/industry-config.js";
import { setAgenda, holdMeeting, draftMinutes, approveMinutes } from "../../../../../../lib/board-management.js";

const ACTIONS = {
  setAgenda: (args) => setAgenda(args),
  hold: (args) => holdMeeting(args),
  draftMinutes: (args) => draftMinutes(args),
  approveMinutes: (args) => approveMinutes(args),
};

function serialize(m) {
  return { id: m._id.toString(), status: m.status, agenda: m.agenda, attendees: m.attendees, minutesText: m.minutesText };
}

export async function PATCH(req, { params }) {
  try {
    const { meetingId } = await params;
    const body = await req.json();
    const { orgId, action } = body;
    if (!orgId || !action) return NextResponse.json({ error: "orgId and action are required." }, { status: 400 });
    const impl = ACTIONS[action];
    if (!impl) return NextResponse.json({ error: `Unknown action "${action}".` }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const verticalCheck = await requireVertical(orgId, "private_capital");
    if (verticalCheck.error) return NextResponse.json({ error: verticalCheck.error }, { status: verticalCheck.status });

    const result = await impl({ orgId, meetingId, agendaItems: body.agendaItems, attendees: body.attendees, minutesText: body.minutesText, actorEmail: auth.session.email, membership: auth.membership });
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ meeting: serialize(result.meeting) });
  } catch (err) {
    console.error("orgs/private-capital/board-meetings/[meetingId] PATCH failed:", err);
    return NextResponse.json({ error: "Could not update board meeting." }, { status: 500 });
  }
}
