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
import { notifyIdeaStatus } from "../../../../../lib/workspaceIdeas.js";

export const dynamic = "force-dynamic";

export async function PATCH(req, { params }) {
  params = await params; // Next.js 15: params is a Promise (SQA 17 Nov 2026)
  try {
    if (!isAdminAuthenticated(req)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!ObjectId.isValid(params.id)) {
      return NextResponse.json({ error: "Invalid id." }, { status: 400 });
    }

    const { status, adminNotes, sprint, publicBoard } = await req.json();
    // Workspace ideas (23 Nov 2026): which development sprint, and whether other companies may see/vote on it.
    if (sprint !== undefined && sprint !== null && (typeof sprint !== "string" || sprint.length > 40)) return NextResponse.json({ error: "sprint must be a short text, e.g. \"Sprint 3\"." }, { status: 400 });
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
    if (sprint !== undefined) update.sprint = sprint ? sprint.trim() : null;
    if (publicBoard !== undefined) update.publicBoard = publicBoard === true;

    const { feedback } = await getFeedbackCollections();
    const result = await feedback.findOneAndUpdate(
      { _id: new ObjectId(params.id) },
      { $set: update },
      { returnDocument: "after" }
    );
    if (!result) return NextResponse.json({ error: "Not found." }, { status: 404 });
    if (status !== undefined) await notifyIdeaStatus(result).catch(() => 0); // tells the submitter + voters when Planned / Shipped

    return NextResponse.json({ ...result, _id: result._id.toString() });
  } catch (err) {
    console.error("admin/feedback/[id] PATCH failed:", err);
    return NextResponse.json({ error: "Could not update submission." }, { status: 500 });
  }
}

export async function DELETE(req, { params }) {
  params = await params; // Next.js 15: params is a Promise (SQA 17 Nov 2026)
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
