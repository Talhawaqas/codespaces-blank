// app/api/admin/feedback/route.js
//
// GET /api/admin/feedback?key=SECRET — private, same single-shared-secret
// gate as /api/admin/dashboard (process.env.ADMIN_DASHBOARD_SECRET). Not
// linked from the public site. Returns the raw submission list, newest
// first; summary counts are derived client-side by the dashboard page,
// same as it already does for the Watcher Pioneer active-wallet count.

import { NextResponse } from "next/server";
import { ensureFeedbackIndexes, getFeedbackCollections } from "../../../../lib/feedback.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const key = searchParams.get("key");
    if (!process.env.ADMIN_DASHBOARD_SECRET || key !== process.env.ADMIN_DASHBOARD_SECRET) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    await ensureFeedbackIndexes();
    const { feedback } = await getFeedbackCollections();
    const rows = await feedback.find({}).sort({ createdAt: -1 }).toArray();

    return NextResponse.json({
      submissions: rows.map((r) => ({ ...r, _id: r._id.toString() })),
    });
  } catch (err) {
    console.error("admin/feedback failed:", err);
    return NextResponse.json({ error: "Could not load feedback." }, { status: 500 });
  }
}
