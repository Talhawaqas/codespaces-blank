// app/api/backup/cron/check-pins/route.js
//
// GET /api/backup/cron/check-pins -- CRON_SECRET-gated, same Bearer-auth pattern as
// api/bridge/cron/relay-messages/route.js. Tier 1 of the SOW's failure-detection requirement:
// cheap, frequent pin-status checks (schedule: every 15 min, see vercel.json). A single miss
// does not fail a replica -- see backupHealth.js's CONSECUTIVE_FAILURE_THRESHOLD grace window.

import { NextResponse } from "next/server";
import { runCheckPinsSweep } from "../../../../../lib/backupEngine";

export async function GET(request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const summary = await runCheckPinsSweep({});
    return NextResponse.json({ success: true, ...summary });
  } catch (err) {
    console.error("backup/cron/check-pins failed:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
