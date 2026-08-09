// app/api/orgs/documents/[documentId]/activity/route.js
//
// GET /api/orgs/documents/:documentId/activity?orgId=...
//
// The immutable audit trail for one document, oldest first (chronological
// order — this is a history, not a feed). Same department-scoped
// visibility as the document itself: if you can't see the document, you
// can't see its history either.

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership, canAccessDepartment, toObjectId } from "../../../../../../lib/orgs.js";

export async function GET(req, { params }) {
  try {
    const { documentId } = params;
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { orgDocuments, documentActivity } = await getOrgCollections();
    const orgObjectId = toObjectId(orgId);
    const documentObjectId = toObjectId(documentId);

    const doc = await orgDocuments.findOne({ _id: documentObjectId, orgId: orgObjectId });
    if (!doc) return NextResponse.json({ error: "Document not found." }, { status: 404 });
    if (!canAccessDepartment(auth.membership, doc.departmentId)) {
      return NextResponse.json({ error: "You don't have access to this department." }, { status: 403 });
    }

    const events = await documentActivity
      .find({ documentId: documentObjectId })
      .sort({ timestamp: 1 })
      .toArray();

    return NextResponse.json({
      activity: events.map((e) => ({
        eventId: e.eventId,
        actorId: e.actorId,
        action: e.action,
        previousState: e.previousState,
        newState: e.newState,
        timestamp: e.timestamp,
        metadata: e.metadata,
      })),
    });
  } catch (err) {
    console.error("orgs/documents/[documentId]/activity failed:", err);
    return NextResponse.json({ error: "Could not fetch document activity." }, { status: 500 });
  }
}
