// GET /api/cron/watcher-backup
// SQA-038 — takes a full snapshot of the Watcher Pioneer Program's data
// and uploads it to Vercel Blob. Same Vercel Cron gate convention as every
// other route under api/cron/* (Authorization: Bearer $CRON_SECRET).

import { NextResponse } from "next/server";
import { runWatcherBackup } from "../../../../lib/watcherBackup.js";

export async function GET(request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runWatcherBackup();
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    console.error("cron/watcher-backup failed:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
