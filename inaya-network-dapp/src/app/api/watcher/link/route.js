// app/api/watcher/link/route.js
//
// POST /api/watcher/link
// Body: { idToken, provider?, walletAddress, message, signature, timestamp }
//
// Connects a social login to a wallet for the Watcher Pioneer Program. Requires BOTH a fresh provider token and a wallet signature over the
// "link_social" request (see buildWatcherMessage in watcherPioneer.js), so neither side can be linked by someone who controls only the other.
//   * login already has a social account -> the wallet is added to it (for the upload qualifying action and for receiving rewards).
//   * login has no account, wallet has one  -> the login is attached to the wallet's existing account; its points and sessions are untouched.
// Nothing is merged or moved: linking two accounts that each already have their own record is refused.

import { NextResponse } from "next/server";
import { ensureWatcherIndexes } from "../../../../lib/watcherPioneer.js";
import { verifySocialLogin, linkLoginToWallet } from "../../../../lib/watcherSocial.js";

export const dynamic = "force-dynamic";

export async function POST(req) {
  try {
    const body = await req.json();
    let login;
    try { login = await verifySocialLogin({ provider: body.provider, idToken: body.idToken }); }
    catch (authErr) { return NextResponse.json({ error: authErr.message }, { status: 401 }); }

    await ensureWatcherIndexes();
    try {
      const result = await linkLoginToWallet({ login, walletAddress: body.walletAddress, message: body.message, signature: body.signature, timestamp: body.timestamp });
      return NextResponse.json(result);
    } catch (linkErr) {
      // signature problems come from verifyWatcherAuth as plain Errors: those are the caller's mistake (400); program refusals carry a status
      return NextResponse.json({ error: linkErr.message }, { status: linkErr.status || 400 });
    }
  } catch (err) {
    console.error("watcher/link failed:", err);
    return NextResponse.json({ error: "Could not link. Please try again." }, { status: 500 });
  }
}
