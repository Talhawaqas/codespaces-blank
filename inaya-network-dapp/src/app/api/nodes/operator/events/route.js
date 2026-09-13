// app/api/nodes/operator/events/route.js
//
// GET /api/nodes/operator/events?limit= — paginated node_events for the
// session's own wallet, newest first. Events are written only by
// server-side code (the hourly snapshot cron, nodeUptimeHistory.js) --
// never by the client -- so this is a pure read.

import { NextResponse } from "next/server";
import { requireNodeSession } from "../../../../../lib/nodeOperatorAuth.js";
import { getNodeHistoryCollections } from "../../../../../lib/nodeUptimeHistory.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function GET(req) {
  try {
    const session = await requireNodeSession(req);
    if (session.error) return NextResponse.json({ error: session.error }, { status: session.status });

    const rawLimit = Number(req.nextUrl.searchParams.get("limit"));
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT;

    const { events } = await getNodeHistoryCollections();
    const rows = await events
      .find({ walletAddress: session.walletAddress })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();

    return NextResponse.json({
      events: rows.map((e) => ({ type: e.type, severity: e.severity, message: e.message, meta: e.meta || {}, createdAt: e.createdAt })),
    });
  } catch (err) {
    console.error("nodes/operator/events GET failed:", err);
    return NextResponse.json({ error: "Could not load event history." }, { status: 500 });
  }
}
