// app/api/dataroom/documents/[documentId]/stream/route.js
//
// GET /api/dataroom/documents/:documentId/stream — proxies the document's
// bytes from the Pinata gateway server-side rather than redirecting the
// browser straight to a raw gateway URL. Two reasons: (1) investors never
// see/can't easily copy-share a bare IPFS gateway link, and (2) this is
// the one place a document is definitely being opened, so it's the
// correct anchor point to log the "opened" view event server-side rather
// than trusting a client-side beacon that might not fire.
//
// Content-Disposition: inline (not attachment) so the browser renders the
// PDF in the <iframe> the /dataroom page embeds it in, instead of
// triggering a download.

import { NextResponse } from "next/server";
import { getDataroomVisitor, getDataroomCollections, toObjectId, recordViewOpened } from "../../../../../../lib/dataroom.js";

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

    const gatewayRes = await fetch(`https://gateway.pinata.cloud/ipfs/${doc.cid}`);
    if (!gatewayRes.ok) {
      console.error(`dataroom/documents/stream: gateway returned ${gatewayRes.status} for cid ${doc.cid}`);
      return NextResponse.json({ error: "Could not load this document. Please try again." }, { status: 502 });
    }

    // Buffered rather than passing gatewayRes.body straight through —
    // piping a raw fetch ReadableStream into NextResponse is inconsistent
    // across Vercel's runtimes (worked fine locally, 502'd in production
    // with an ok, 200 upstream response — confirmed by fetching the same
    // CID directly, which succeeded). Buffering trades a small amount of
    // serverless memory for a body type NextResponse always handles
    // correctly; these documents are capped at 50MB, well within budget.
    const buffer = await gatewayRes.arrayBuffer();

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
