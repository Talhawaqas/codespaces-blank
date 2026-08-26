// app/api/admin/faucet/requests/route.js
//
// GET /api/admin/faucet/requests — admin-only, recent faucet requests
// for the /admin/faucet dashboard. Same passphrase session as every
// other /api/admin/* route. Optional ?wallet=0x... filters to one
// address's full history instead of the global recent list.

import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "../../../../../lib/admin-auth.js";
import { listRecentFaucetRequests, listFaucetRequestsForWallet } from "../../../../../lib/faucet.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  if (!isAdminAuthenticated(req)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  try {
    const wallet = new URL(req.url).searchParams.get("wallet");
    const items = wallet ? await listFaucetRequestsForWallet(wallet) : await listRecentFaucetRequests(200);
    return NextResponse.json({ items });
  } catch (err) {
    console.error("admin/faucet/requests GET failed:", err);
    return NextResponse.json({ error: "Could not load faucet requests." }, { status: 500 });
  }
}
