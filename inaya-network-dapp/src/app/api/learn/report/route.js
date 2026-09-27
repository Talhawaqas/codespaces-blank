// app/api/learn/report/route.js
//
// POST /api/learn/report — reports an irrelevant/unavailable/problematic
// search result (spec §18). Data collection only in V1 — no admin review
// screen; a future admin route can read this same collection.

import { NextResponse } from "next/server";
import { checkRateLimit, getClientIp } from "../../../../lib/rateLimit.js";
import { ensureLearnIndexes, getLearnCollections, validateReportInput } from "../../../../lib/learn.js";

export const dynamic = "force-dynamic";

export async function POST(req) {
  try {
    // SQA-012: anonymous endpoint -- bounded per IP so it cannot be used to flood the database or harvest records
    try { await checkRateLimit({ action: "learn:report", key: getClientIp(req), max: 20, windowMs: 3600000 }); }
    catch (err) { return NextResponse.json({ error: err.message }, { status: 429 }); }
    const body = await req.json();

    let clean;
    try {
      clean = validateReportInput(body);
    } catch (validationErr) {
      return NextResponse.json({ error: validationErr.message }, { status: 400 });
    }

    await ensureLearnIndexes();
    const { reports } = await getLearnCollections();
    await reports.insertOne({ ...clean, createdAt: new Date() });

    return NextResponse.json({ reported: true });
  } catch (err) {
    console.error("learn/report failed:", err);
    return NextResponse.json({ error: "Could not submit report." }, { status: 500 });
  }
}
