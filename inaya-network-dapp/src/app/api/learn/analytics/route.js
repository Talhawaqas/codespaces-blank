// app/api/learn/analytics/route.js
//
// POST /api/learn/analytics — fire-and-forget product-usage event logging
// (spec §14). No PII by design: event type + optional categoryId/videoId
// only, no user identifier is stored. A real analytics platform
// integration (Amplitude/PostHog/etc.) is a separate future decision, not
// bundled here — this is just a Mongo insert for aggregated counts.

import { NextResponse } from "next/server";
import { ensureLearnIndexes, getLearnCollections, validateAnalyticsInput } from "../../../../lib/learn.js";

export const dynamic = "force-dynamic";

export async function POST(req) {
  try {
    const body = await req.json();

    let clean;
    try {
      clean = validateAnalyticsInput(body);
    } catch (validationErr) {
      return NextResponse.json({ error: validationErr.message }, { status: 400 });
    }

    await ensureLearnIndexes();
    const { analytics } = await getLearnCollections();
    await analytics.insertOne({ ...clean, createdAt: new Date() });

    return NextResponse.json({ logged: true });
  } catch (err) {
    // Analytics must never break the user-facing flow that triggered it —
    // log server-side and return success regardless.
    console.error("learn/analytics failed:", err);
    return NextResponse.json({ logged: false });
  }
}
