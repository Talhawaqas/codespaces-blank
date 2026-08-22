// app/api/admin/security/threats/[threatId]/override/route.js
//
// POST /api/admin/security/threats/:threatId/override
// Body: { status, confidenceBps }
//
// isAdminAuthenticated-gated manual quarantine/dismiss override (SOW §19's
// "administrative/governance controls" anti-abuse requirement) — routes
// through the same relayer-gated on-chain setThreatStatus as everything
// else, so an admin override is exactly as auditable as an automatic
// confirmation.

import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "../../../../../../../lib/admin-auth.js";
import { adminOverrideThreatStatus } from "../../../../../../../lib/security.js";

export const dynamic = "force-dynamic";

export async function POST(req, { params }) {
  if (!isAdminAuthenticated(req)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const { threatId } = params;
    const { status, confidenceBps } = await req.json();

    if (typeof status !== "number" || status < 0 || status > 3) {
      return NextResponse.json({ error: "status must be 0 (Unverified), 1 (Confirmed), 2 (Disputed), or 3 (Cleared)." }, { status: 400 });
    }

    const result = await adminOverrideThreatStatus(threatId, status, confidenceBps ?? 0);
    return NextResponse.json(result);
  } catch (err) {
    console.error("admin/security/threats override POST failed:", err);
    return NextResponse.json({ error: err.message || "Override failed." }, { status: 500 });
  }
}
