// app/api/admin/dataroom/visitors/route.js
//
// GET /api/admin/dataroom/visitors — the "who's engaged" view this whole
// feature is for: every visitor plus their per-document view history and
// total time spent, via getVisitorEngagementSummary().

import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "../../../../../lib/admin-auth.js";
import { getVisitorEngagementSummary } from "../../../../../lib/dataroom.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  if (!isAdminAuthenticated(req)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const visitors = await getVisitorEngagementSummary();
    return NextResponse.json({ visitors });
  } catch (err) {
    console.error("admin/dataroom/visitors GET failed:", err);
    return NextResponse.json({ error: "Could not load visitors." }, { status: 500 });
  }
}
