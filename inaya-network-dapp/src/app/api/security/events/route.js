// app/api/security/events/route.js
//
// POST /api/security/events
// Body: { identityId, surface, eventType, destination, decision, reason, confidenceBps, category }
//
// Public. Client-side block/warn/allow decision log — this IS the "Recent
// security events" history the user sees and the AI Security Assistant
// reads from, so unlike a pure analytics ping (activity.js's fire-and-
// forget pattern), a validation failure here is a real 400, not silently
// swallowed — clients should know if their event didn't record.
//
// GET /api/security/events?identityId=&limit=
//
// Public read of one identity's own recent history (no auth system exists
// for anonymous device/wallet identities in this codebase yet — same trust
// model as every other client-provided-address route: Watcher Pioneer,
// Referrals, activity.js).

import { NextResponse } from "next/server";
import { ensureSecurityIndexes, recordSecurityEvent, getRecentSecurityEvents } from "../../../../lib/security.js";

export const dynamic = "force-dynamic";

export async function POST(req) {
  try {
    const body = await req.json();
    await ensureSecurityIndexes();

    let event;
    try {
      event = await recordSecurityEvent(body);
    } catch (validationErr) {
      return NextResponse.json({ error: validationErr.message }, { status: 400 });
    }

    return NextResponse.json({ recorded: true, event });
  } catch (err) {
    console.error("security/events POST failed:", err);
    return NextResponse.json({ error: "Could not record event." }, { status: 500 });
  }
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const identityId = searchParams.get("identityId");
    const limit = Number(searchParams.get("limit")) || 20;
    if (!identityId) {
      return NextResponse.json({ error: "identityId query param is required." }, { status: 400 });
    }

    await ensureSecurityIndexes();
    const events = await getRecentSecurityEvents(identityId, limit);
    return NextResponse.json({ events });
  } catch (err) {
    console.error("security/events GET failed:", err);
    return NextResponse.json({ error: "Could not load events." }, { status: 500 });
  }
}
