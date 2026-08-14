// app/api/watcher/status/route.js
//
// GET /api/watcher/status?walletAddress=0x...
//
// Polling-friendly read (no signature required, matches referrals/status's
// convention) — also the mechanism that settles any expired session lazily
// on read, since this codebase has no cron/queue infra to award points on
// a schedule (see watcherPioneer.js's settleExpiredSession).

import { NextResponse } from "next/server";
import { ensureWatcherIndexes, getPioneerStatus, normalizeWallet } from "../../../../lib/watcherPioneer.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const wallet = normalizeWallet(searchParams.get("walletAddress") || "");
    if (!wallet) {
      return NextResponse.json({ error: "walletAddress is required." }, { status: 400 });
    }

    await ensureWatcherIndexes();
    const status = await getPioneerStatus(wallet);
    return NextResponse.json(status);
  } catch (err) {
    console.error("watcher/status failed:", err);
    return NextResponse.json({ error: "Could not fetch status." }, { status: 500 });
  }
}
