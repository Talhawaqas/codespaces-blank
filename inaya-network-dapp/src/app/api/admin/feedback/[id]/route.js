// app/api/admin/feedback/[id]/route.js
//
// PATCH /api/admin/feedback/[id] — body {status?, adminNotes?}
// DELETE /api/admin/feedback/[id] — removes a submission (spam)
//
// Same cookie-based admin session gate as the rest of /api/admin/* (admin-auth.js).

import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { isAdminAuthenticated } from "../../../../../lib/admin-auth.js";
import { getFeedbackCollections, FEEDBACK_STATUSES } from "../../../../../lib/feedback.js";

export const dynamic = "force-dynamic";

export async function PATCH(req, { params }) {
  try {
    if (!isAdminAuthenticated(req)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!ObjectId.isValid(params.id)) {
      return NextResponse.json({ error: "Invalid id." }, { status: 400 });
    }

    const { status, adminNotes } = await req.json();
    const update = { updatedAt: new Date() };
    if (status !== undefined) {
      if (!FEEDBACK_STATUSES.includes(status)) {
        return NextResponse.json({ error: `status must be one of: ${FEEDBACK_STATUSES.join(", ")}.` }, { status: 400 });
      }
      update.status = status;
    }
    if (adminNotes !== undefined) {
      if (typeof adminNotes !== "string" || adminNotes.length > 5000) {
        return NextResponse.json({ error: "adminNotes must be a string under 5000 characters." }, { status: 400 });
      }
      update.adminNotes = adminNotes;
    }

    const { feedback } = await getFeedbackCollections();
    const result = await feedback.findOneAndUpdate(
      { _id: new ObjectId(params.id) },
      { $set: update },
      { returnDocument: "after" }
    );
    if (!result) return NextResponse.json({ error: "Not found." }, { status: 404 });

    return NextResponse.json({ ...result, _id: result._id.toString() });
  } catch (err) {
    console.error("admin/feedback/[id] PATCH failed:", err);
    return NextResponse.json({ error: "Could not update submission." }, { status: 500 });
  }
}

export async function DELETE(req, { params }) {
  try {
    if (!isAdminAuthenticated(req)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!ObjectId.isValid(params.id)) {
      return NextResponse.json({ error: "Invalid id." }, { status: 400 });
    }

    const { feedback } = await getFeedbackCollections();
    const result = await feedback.deleteOne({ _id: new ObjectId(params.id) });
    if (result.deletedCount === 0) return NextResponse.json({ error: "Not found." }, { status: 404 });

    return NextResponse.json({ deleted: true });
  } catch (err) {
    console.error("admin/feedback/[id] DELETE failed:", err);
    return NextResponse.json({ error: "Could not delete submission." }, { status: 500 });
  }
}
