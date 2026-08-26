// app/api/dataroom/documents/[documentId]/stream/route.js
//
// GET /api/dataroom/documents/:documentId/stream — reads the document's
// bytes out of MongoDB GridFS server-side rather than exposing storage
// internals to the browser directly. This is also the one place a
// document is definitely being opened, so it's the correct anchor point
// to log the "opened" view event server-side rather than trusting a
// client-side beacon that might not fire.
//
// Content-Disposition: inline (not attachment) so the browser renders the
// PDF in the <iframe> the /dataroom page embeds it in, instead of
// triggering a download.

import { NextResponse } from "next/server";
import { getDataroomVisitor, getDataroomCollections, toObjectId, recordViewOpened, readDocumentFile, readVideoFile } from "../../../../../../lib/dataroom.js";

export const dynamic = "force-dynamic";

export async function GET(req, { params }) {
  try {
    const visitor = await getDataroomVisitor(req);
    if (!visitor) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    if (!visitor.ndaAcceptedAt) return NextResponse.json({ error: "NDA not yet accepted." }, { status: 403 });

    const { documentId } = params;
    const { documents } = await getDataroomCollections();
    const doc = await documents.findOne({ _id: toObjectId(documentId) });
    if (!doc) return NextResponse.json({ error: "Document not found." }, { status: 404 });

    let buffer;
    try {
      buffer = doc.storageType === "blob" ? await readVideoFile(doc.blobPathname) : await readDocumentFile(doc.fileId);
    } catch (err) {
      console.error(`dataroom/documents/stream: read failed for document ${doc._id}:`, err.message);
      return NextResponse.json({ error: "Could not load this document. Please try again." }, { status: 502 });
    }

    await recordViewOpened({ visitorId: visitor._id, documentId: doc._id });

    return new NextResponse(buffer, {
      status: 200,
      headers: {
        "Content-Type": doc.mimeType || "application/octet-stream",
        "Content-Disposition": `inline; filename="${doc.filename}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    console.error("dataroom/documents/stream failed:", err);
    return NextResponse.json({ error: "Could not load this document." }, { status: 500 });
  }
}
