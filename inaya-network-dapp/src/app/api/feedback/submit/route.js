// app/api/feedback/submit/route.js
//
// POST /api/feedback/submit — public, no login required (same openness as
// /api/referrals/activate). Body carries the user-authored form fields
// plus auto-captured context (timestamp/route/wallet/device/browser/
// network) the frontend gathers itself — see page.js's feedback modal.

import { NextResponse } from "next/server";
import { ensureFeedbackIndexes, getFeedbackCollections, validateFeedbackInput, cleanContextFields } from "../../../../lib/feedback.js";

export const dynamic = "force-dynamic";

export async function POST(req) {
  try {
    const body = await req.json();

    let clean;
    try {
      clean = validateFeedbackInput(body);
    } catch (validationErr) {
      return NextResponse.json({ error: validationErr.message }, { status: 400 });
    }

    const context = cleanContextFields(body);
    await ensureFeedbackIndexes();
    const { feedback } = await getFeedbackCollections();

    const now = new Date();
    const { insertedId } = await feedback.insertOne({
      ...clean,
      ...context,
      status: "New",
      adminNotes: "",
      createdAt: now,
      updatedAt: now,
    });

    return NextResponse.json({ id: insertedId.toString() });
  } catch (err) {
    console.error("feedback/submit failed:", err);
    return NextResponse.json({ error: "Could not submit feedback. Please try again." }, { status: 500 });
  }
}
