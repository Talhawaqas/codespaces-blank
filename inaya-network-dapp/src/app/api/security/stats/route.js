// app/api/security/stats/route.js
//
// GET /api/security/stats
//
// Public. Network-wide, public-safe aggregate stats for the /security
// transparency page — counts and an average only, never raw node
// addresses or the underlying report data (those stay admin-only, see
// /api/admin/security/nodes).

import { NextResponse } from "next/server";
import { ensureSecurityIndexes, getPublicSecurityStats } from "../../../../lib/security.js";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await ensureSecurityIndexes();
    const stats = await getPublicSecurityStats();
    return NextResponse.json(stats);
  } catch (err) {
    console.error("security/stats GET failed:", err);
    return NextResponse.json({ error: "Could not load stats." }, { status: 500 });
  }
}
