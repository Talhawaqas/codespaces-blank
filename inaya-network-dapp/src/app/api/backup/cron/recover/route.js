// app/api/backup/cron/recover/route.js
//
// GET /api/backup/cron/recover -- CRON_SECRET-gated (schedule: every 10 min, see vercel.json).
// Automatic re-replication: finds every asset whose cached state is Recovery Required, fetches a
// healthy replica of the affected shard, verifies its content hash before accepting it, and
// re-pins to restore the target replica count -- the SOW's "automatic recovery/re-replication"
// requirement.

import { NextResponse } from "next/server";
import { runRecoverySweep } from "../../../../../lib/backupEngine";

export async function GET(request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const summary = await runRecoverySweep({});
    return NextResponse.json({ success: true, ...summary });
  } catch (err) {
    console.error("backup/cron/recover failed:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
