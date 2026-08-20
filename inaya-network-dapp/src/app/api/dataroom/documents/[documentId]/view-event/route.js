// app/api/dataroom/documents/[documentId]/view-event/route.js
//
// POST /api/dataroom/documents/:documentId/view-event — { event: "heartbeat" | "closed" }.
// The client posts a heartbeat every ~15s while a document is open and a
// "closed" event on unmount/beforeunload — this is what makes duration
// tracking survive an abrupt tab close instead of only recording a clean
// exit (see recordViewEvent's comment in src/lib/dataroom.js for how
// duration is computed from whichever of these actually landed last).

import { NextResponse } from "next/server";
import { getDataroomVisitor, recordViewEvent } from "../../../../../../lib/dataroom.js";

export const dynamic = "force-dynamic";

const VALID_EVENTS = ["heartbeat", "closed"];

export async function POST(req, { params }) {
  try {
    const visitor = await getDataroomVisitor(req);
    if (!visitor) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

    const { documentId } = params;
    const { event } = await req.json();
    if (!VALID_EVENTS.includes(event)) {
      return NextResponse.json({ error: "Invalid event." }, { status: 400 });
    }

    await recordViewEvent({ visitorId: visitor._id, documentId, event });
    return NextResponse.json({ recorded: true });
  } catch (err) {
    // View telemetry must never break the viewer UI over a logging hiccup.
    console.error("dataroom/documents/view-event failed:", err);
    return NextResponse.json({ recorded: false });
  }
}
