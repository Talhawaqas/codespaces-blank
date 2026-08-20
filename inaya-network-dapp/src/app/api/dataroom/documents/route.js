// app/api/dataroom/documents/route.js
//
// GET /api/dataroom/documents — lists all data room documents, gated on a
// verified session AND an accepted NDA (not just verified — an investor
// who hasn't agreed to the NDA yet shouldn't see the document list at
// all, let alone open one).

import { NextResponse } from "next/server";
import { getDataroomVisitor, getDataroomCollections } from "../../../../lib/dataroom.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    const visitor = await getDataroomVisitor(req);
    if (!visitor) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    if (!visitor.ndaAcceptedAt) return NextResponse.json({ error: "NDA not yet accepted." }, { status: 403 });

    const { documents } = await getDataroomCollections();
    const items = await documents.find({}).sort({ order: 1, uploadedAt: 1 }).toArray();

    return NextResponse.json({
      items: items.map((d) => ({
        id: d._id.toString(),
        title: d.title,
        category: d.category,
        filename: d.filename,
        sizeBytes: d.sizeBytes,
        mimeType: d.mimeType,
        uploadedAt: d.uploadedAt,
      })),
    });
  } catch (err) {
    console.error("dataroom/documents GET failed:", err);
    return NextResponse.json({ error: "Could not load documents." }, { status: 500 });
  }
}
