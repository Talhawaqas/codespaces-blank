// app/api/admin/fraud/assessments/route.js
//
// GET /api/admin/fraud/assessments — admin-only, recent risk assessments
// for the /admin/fraud dashboard. Same passphrase session as every other
// /api/admin/* route.

import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "../../../../../lib/admin-auth.js";
import { listRecentAssessments } from "../../../../../lib/fraudRisk.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  if (!isAdminAuthenticated(req)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  try {
    const items = await listRecentAssessments(200);
    return NextResponse.json({ items });
  } catch (err) {
    console.error("admin/fraud/assessments GET failed:", err);
    return NextResponse.json({ error: "Could not load assessments." }, { status: 500 });
  }
}
