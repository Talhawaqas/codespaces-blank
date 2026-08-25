// app/api/admin/fraud/stats/route.js
//
// GET /api/admin/fraud/stats — admin-only, summary counts (by risk level,
// by classification) for the /admin/fraud dashboard header.

import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "../../../../../lib/admin-auth.js";
import { getFraudStats } from "../../../../../lib/fraudRisk.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  if (!isAdminAuthenticated(req)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  try {
    const stats = await getFraudStats();
    return NextResponse.json(stats);
  } catch (err) {
    console.error("admin/fraud/stats GET failed:", err);
    return NextResponse.json({ error: "Could not load stats." }, { status: 500 });
  }
}
