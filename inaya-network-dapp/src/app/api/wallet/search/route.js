// app/api/wallet/search/route.js
//
// GET /api/wallet/search?address=&q=
//
// Enterprise OS SOW, Phase 4. Unauthenticated — same trust tier as GET
// /api/metadata/list-files?owner=0x... (already unauthenticated,
// filename-level exposure), which this is a filtered view of.

import { NextResponse } from "next/server";
import { searchWallet } from "../../../../lib/walletSearch.js";

export async function GET(req) {
  try {
    const url = new URL(req.url);
    const address = url.searchParams.get("address");
    const query = url.searchParams.get("q") || "";
    if (!address) return NextResponse.json({ error: "address is required." }, { status: 400 });

    const results = await searchWallet({ walletAddress: address, query });
    return NextResponse.json({ results });
  } catch (err) {
    console.error("wallet/search failed:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
