// app/api/nodes/operator/uptime/route.js
//
// GET /api/nodes/operator/uptime?window=24h|7d|30d|90d|lifetime
// Thin wrapper over nodeUptimeHistory.js's getUptimeForWindow(), scoped to
// the session's own wallet.

import { NextResponse } from "next/server";
import { requireNodeSession } from "../../../../../lib/nodeOperatorAuth.js";
import { getUptimeForWindow } from "../../../../../lib/nodeUptimeHistory.js";

const VALID_WINDOWS = ["24h", "7d", "30d", "90d", "lifetime"];

export async function GET(req) {
  try {
    const session = await requireNodeSession(req);
    if (session.error) return NextResponse.json({ error: session.error }, { status: session.status });

    const window = req.nextUrl.searchParams.get("window") || "30d";
    if (!VALID_WINDOWS.includes(window)) {
      return NextResponse.json({ error: `window must be one of: ${VALID_WINDOWS.join(", ")}` }, { status: 400 });
    }

    const result = await getUptimeForWindow(session.walletAddress, window === "lifetime" ? "lifetime" : window);
    return NextResponse.json(result);
  } catch (err) {
    console.error("nodes/operator/uptime GET failed:", err);
    return NextResponse.json({ error: "Could not load uptime history." }, { status: 500 });
  }
}
