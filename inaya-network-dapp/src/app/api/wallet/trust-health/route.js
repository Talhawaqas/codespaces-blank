// app/api/wallet/trust-health/route.js
//
// GET /api/wallet/trust-health?address=0x...
//
// Enterprise OS SOW, Phase 2. Deliberately unauthenticated, same trust
// tier as GET /api/metadata/list-files?owner=0x... and GET
// /api/backup/status?fileHash=0x... (both already unauthenticated,
// read-only, keyed by a public identifier) — this route returns only
// aggregate counts (how many flagged events, how many assets need
// recovery), never plaintext, a file list, or anything a signature would
// meaningfully gate. Same precedent AddressRiskCheck.js already
// establishes for checking an arbitrary address's public threat status.

import { NextResponse } from "next/server";
import { computeTrustHealthSnapshot } from "../../../../lib/trustHealth.js";

export async function GET(req) {
  try {
    const address = new URL(req.url).searchParams.get("address");
    if (!address) return NextResponse.json({ error: "address is required." }, { status: 400 });

    const snapshot = await computeTrustHealthSnapshot({ scope: "wallet", walletAddress: address });
    return NextResponse.json(snapshot);
  } catch (err) {
    console.error("wallet/trust-health failed:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
