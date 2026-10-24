// app/api/health/report/route.js
//
// POST /api/health/report — where the daily AI health routine leaves its
// summary (src/lib/healthReport.js). Bearer HEALTH_REPORT_TOKEN only; the
// token can do nothing but store a short text that is later emailed to the
// owner, so a leaked token at worst sends the owner a misleading report.

import { NextResponse } from "next/server";
import { bearerMatches } from "@/lib/cronAuth";
import { saveHealthReport } from "../../../../lib/healthReport.js";

export const dynamic = "force-dynamic";

export async function POST(req) {
  if (!bearerMatches(req.headers.get("authorization"), process.env.HEALTH_REPORT_TOKEN)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON: { status, summary }." }, { status: 400 });
  }
  try {
    const result = await saveHealthReport({ status: body?.status, summary: body?.summary });
    if (result.error) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json({ saved: true, day: result.day });
  } catch (err) {
    console.error("health/report failed:", err);
    return NextResponse.json({ error: "Could not save the report." }, { status: 500 });
  }
}
