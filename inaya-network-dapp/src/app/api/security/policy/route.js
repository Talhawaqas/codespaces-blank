// app/api/security/policy/route.js
//
// GET /api/security/policy
//
// Public. Returns the current policy bundle plus a relayer signature over
// its hash, so a client can verify it wasn't tampered with in transit or
// at rest WITHOUT a live RPC call once cached (SOW §10: "signature/status
// verification", "offline operation"). The on-chain InayaSecurityPolicy
// record is the permanent, tamper-evident version history; this route is
// the fast path clients actually poll.

import { NextResponse } from "next/server";
import { ensureSecurityIndexes, getCurrentPolicy } from "../../../../lib/security.js";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await ensureSecurityIndexes();
    const policy = await getCurrentPolicy();
    if (!policy) {
      return NextResponse.json({ error: "No policy published yet." }, { status: 404 });
    }
    return NextResponse.json(policy);
  } catch (err) {
    console.error("security/policy GET failed:", err);
    return NextResponse.json({ error: "Could not load policy." }, { status: 500 });
  }
}
