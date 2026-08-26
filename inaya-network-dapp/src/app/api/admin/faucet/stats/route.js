// app/api/admin/faucet/stats/route.js
//
// GET /api/admin/faucet/stats — admin-only, aggregate faucet numbers
// for the /admin/faucet dashboard. Same passphrase session as every
// other /api/admin/* route.

import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "../../../../../lib/admin-auth.js";
import { getFaucetStats } from "../../../../../lib/faucet.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  if (!isAdminAuthenticated(req)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  try {
    const stats = await getFaucetStats();
    return NextResponse.json(stats);
  } catch (err) {
    console.error("admin/faucet/stats GET failed:", err);
    return NextResponse.json({ error: "Could not load faucet stats." }, { status: 500 });
  }
}
