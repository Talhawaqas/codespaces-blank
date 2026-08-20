// app/api/learn/report/route.js
//
// POST /api/learn/report — reports an irrelevant/unavailable/problematic
// search result (spec §18). Data collection only in V1 — no admin review
// screen; a future admin route can read this same collection.

import { NextResponse } from "next/server";
import { ensureLearnIndexes, getLearnCollections, validateReportInput } from "../../../../lib/learn.js";

export const dynamic = "force-dynamic";

export async function POST(req) {
  try {
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
