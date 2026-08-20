// app/api/learn/config/route.js
//
// GET /api/learn/config — public. Returns categories/curated collections/
// learning paths from src/lib/learnConfig.js. Served via API (rather than
// bundled into the mobile app) so this content can change with a backend
// deploy, without a new mobile app build.

import { NextResponse } from "next/server";
import { getLearnConfig } from "../../../../lib/learnConfig.js";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(getLearnConfig());
  } catch (err) {
    console.error("learn/config failed:", err);
    return NextResponse.json({ error: "Could not load Learn configuration." }, { status: 500 });
  }
}
