// app/api/admin/security/nodes/route.js
//
// GET /api/admin/security/nodes
//
// isAdminAuthenticated-gated. Reputation table for every reporting node
// that's ever submitted an observation — the off-chain real-time view,
// same numbers the confidence-weighting math actually uses.

import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "../../../../../lib/admin-auth.js";
import { ensureSecurityIndexes, adminListNodeReputations } from "../../../../../lib/security.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  if (!isAdminAuthenticated(req)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    await ensureSecurityIndexes();
    const nodes = await adminListNodeReputations();
    return NextResponse.json({ items: nodes });
  } catch (err) {
    console.error("admin/security/nodes GET failed:", err);
    return NextResponse.json({ error: "Could not load node reputations." }, { status: 500 });
  }
}
