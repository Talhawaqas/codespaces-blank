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
import { verifySocialLogin, getSocialStatus } from "../../../../lib/watcherSocial.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);

    // Social login: the caller's own provider token in the Authorization header (a login's status includes its email, so unlike the wallet
    // read it is not public). A request with a walletAddress and no token takes the unchanged wallet path.
    const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (bearer && !searchParams.get("walletAddress")) {
      let login;
      try { login = await verifySocialLogin({ provider: searchParams.get("provider") || "google", idToken: bearer }); }
      catch (authErr) { return NextResponse.json({ error: authErr.message }, { status: 401 }); }
      await ensureWatcherIndexes();
      return NextResponse.json(await getSocialStatus({ login }));
    }

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
