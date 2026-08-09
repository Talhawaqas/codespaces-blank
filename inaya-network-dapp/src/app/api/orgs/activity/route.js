// app/api/orgs/activity/route.js
//
// GET /api/orgs/activity?orgId=...
//
// Org-wide activity feed — the same document_activity entries the
// per-document panel shows (documents/[documentId]/activity/route.js),
// merged across every document the caller can currently see
// (getAccessibleScope(), same visibility rules as the dashboard route)
// and sorted newest first. Not a new audit mechanism, just a wider read
// of the existing append-only log.

import { NextResponse } from "next/server";
import { getOrgCollections, ensureOrgIndexes, requireMembership } from "../../../../lib/orgs.js";
import { getAccessibleScope } from "../../../../lib/document-permissions.js";

export async function GET(req) {
  try {
    const orgId = new URL(req.url).searchParams.get("orgId");
    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { visibleDocuments } = await getAccessibleScope({ orgId, membership: auth.membership, email: auth.session.email });
    const docIds = visibleDocuments.map((d) => d._id);
    const filenameById = new Map(visibleDocuments.map((d) => [d._id.toString(), d.filename]));

    const { documentActivity } = await getOrgCollections();
    const events = docIds.length
      ? await documentActivity.find({ documentId: { $in: docIds } }).sort({ timestamp: -1 }).limit(30).toArray()
      : [];

    return NextResponse.json({
      activity: events.map((e) => ({
        eventId: e.eventId,
        documentId: e.documentId.toString(),
        filename: filenameById.get(e.documentId.toString()) || "Unknown document",
        actorId: e.actorId,
        action: e.action,
        previousState: e.previousState,
        newState: e.newState,
        timestamp: e.timestamp,
        metadata: e.metadata,
      })),
    });
  } catch (err) {
    console.error("orgs/activity failed:", err);
    return NextResponse.json({ error: "Could not load activity." }, { status: 500 });
  }
}
