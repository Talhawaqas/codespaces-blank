// app/api/wallet/notifications/route.js
//
// GET /api/wallet/notifications?address=0x...&unreadOnly=true
//
// Enterprise OS SOW, Phase 3. Read-only, unauthenticated — same trust
// tier as GET /api/wallet/trust-health (Phase 2) and the existing
// list-files/backup-status routes: aggregate/summary data keyed by a
// public wallet address, never plaintext. Mutations (read/mark-all-read
// below) DO require a real wallet signature, since those are writes.

import { NextResponse } from "next/server";
import { listNotificationsFor } from "../../../../lib/notifications.js";

export async function GET(req) {
  try {
    const url = new URL(req.url);
    const address = url.searchParams.get("address");
    const unreadOnly = url.searchParams.get("unreadOnly") === "true";
    if (!address) return NextResponse.json({ error: "address is required." }, { status: 400 });

    const notifications = await listNotificationsFor({ scope: "wallet", walletAddress: address, unreadOnly });
    return NextResponse.json({ notifications });
  } catch (err) {
    console.error("wallet/notifications failed:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
