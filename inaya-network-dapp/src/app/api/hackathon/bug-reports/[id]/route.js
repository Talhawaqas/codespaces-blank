// app/api/hackathon/bug-reports/[id]/route.js
//
// PATCH /api/hackathon/bug-reports/[id] — admin-only. Body:
//   { status?, finalSeverity?, triageNotes? }
// Updates the admin's own triage fields on a report. No UI for this yet —
// same bootstrapping as hackathon_winners before any admin UI existed for
// that either; curl/Postman with the admin session cookie is fine for now.

import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { isAdminAuthenticated } from "../../../../../lib/admin-auth";
import { connectToDatabase } from "../../../../../lib/mongodb";
import { isValidSeverity } from "../../../../../lib/hackathon";

const VALID_STATUSES = new Set(["submitted", "confirmed", "duplicate", "rejected", "fixed"]);

export async function PATCH(req, { params }) {
  if (!isAdminAuthenticated(req)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  try {
    const { id } = await params;
    const { status, finalSeverity, triageNotes } = await req.json();

    const update = {};
    if (status !== undefined) {
      if (!VALID_STATUSES.has(status)) {
        return NextResponse.json({ error: `Invalid status "${status}".` }, { status: 400 });
      }
      update.status = status;
    }
    if (finalSeverity !== undefined) {
      if (finalSeverity !== null && !isValidSeverity(finalSeverity)) {
        return NextResponse.json({ error: `Invalid finalSeverity "${finalSeverity}".` }, { status: 400 });
      }
      update.finalSeverity = finalSeverity;
    }
    if (triageNotes !== undefined) {
      update.triageNotes = triageNotes;
    }
    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: "Nothing to update — provide status, finalSeverity, and/or triageNotes." }, { status: 400 });
    }

    const { db } = await connectToDatabase();
    const result = await db.collection("hackathon_bug_reports").findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: update },
      { returnDocument: "after" }
    );
    if (!result) {
      return NextResponse.json({ error: "Report not found." }, { status: 404 });
    }

    return NextResponse.json({ report: { ...result, id: result._id.toString(), _id: undefined } });
  } catch (err) {
    console.error("hackathon/bug-reports/[id] PATCH failed:", err);
    return NextResponse.json({ error: err.message || "Could not update report." }, { status: 400 });
  }
}
