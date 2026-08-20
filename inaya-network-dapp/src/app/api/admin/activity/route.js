// app/api/admin/activity/route.js
//
// GET /api/admin/activity — DAU/WAU for all three surfaces in one call,
// for the Enterprise Dashboard's new "Active Users" section. Gated by
// the current admin session (isAdminAuthenticated), same as the rest of
// /api/admin/* other than the older ?key= feedback routes.

import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "../../../../lib/admin-auth.js";
import { getAllActiveUserStats } from "../../../../lib/activity.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  if (!isAdminAuthenticated(req)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const stats = await getAllActiveUserStats();
    return NextResponse.json(stats);
  } catch (err) {
    console.error("admin/activity failed:", err);
    return NextResponse.json({ error: "Could not load active-user stats." }, { status: 500 });
  }
}
