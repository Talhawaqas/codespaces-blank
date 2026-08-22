// app/api/security/reputation/[address]/route.js
//
// GET /api/security/reputation/:address
//
// Public. Off-chain real-time reputation snapshot for a reporting node —
// the on-chain InayaNodeReputation contract only holds periodic
// checkpoints, this is the live number used for confidence weighting.

import { NextResponse } from "next/server";
import { ensureSecurityIndexes, getReputationSnapshot } from "../../../../../lib/security.js";

export const dynamic = "force-dynamic";

export async function GET(req, { params }) {
  try {
    const { address } = params;
    if (!address) {
      return NextResponse.json({ error: "address is required." }, { status: 400 });
    }
    await ensureSecurityIndexes();
    const snapshot = await getReputationSnapshot(address);
    return NextResponse.json(snapshot);
  } catch (err) {
    console.error("security/reputation GET failed:", err);
    return NextResponse.json({ error: "Could not load reputation." }, { status: 500 });
  }
}
