// app/api/security/feed/route.js
//
// GET /api/security/feed?since=<ISO timestamp>
//
// Public. Incremental threat-cache sync for clients (SOW §10: "incremental
// updates where practical"). Omit `since` for a full first sync (every
// currently-CONFIRMED threat); pass the client's last-synced timestamp to
// get only what changed.

import { NextResponse } from "next/server";
import { ensureSecurityIndexes, getSecurityFeed } from "../../../../lib/security.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const since = searchParams.get("since");

    await ensureSecurityIndexes();
    const feed = await getSecurityFeed(since);
    return NextResponse.json(feed);
  } catch (err) {
    console.error("security/feed GET failed:", err);
    return NextResponse.json({ error: "Could not load feed." }, { status: 500 });
  }
}
