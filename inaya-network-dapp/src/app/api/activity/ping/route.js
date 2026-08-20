// app/api/activity/ping/route.js
//
// POST /api/activity/ping — public, {surface, identityId}. Fire-and-forget
// from every client (dApp, Business Workspace, mobile) — same "never
// break the UI over a logging hiccup" policy as Learn's analytics route.

import { NextResponse } from "next/server";
import { validateActivityPingInput, recordActivityPing } from "../../../../lib/activity.js";

export const dynamic = "force-dynamic";

export async function POST(req) {
  try {
    const body = await req.json();

    let clean;
    try {
      clean = validateActivityPingInput(body);
    } catch (validationErr) {
      return NextResponse.json({ error: validationErr.message }, { status: 400 });
    }

    await recordActivityPing(clean);
    return NextResponse.json({ recorded: true });
  } catch (err) {
    console.error("activity/ping failed:", err);
    return NextResponse.json({ recorded: false });
  }
}
