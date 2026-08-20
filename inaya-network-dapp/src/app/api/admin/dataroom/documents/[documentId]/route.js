// app/api/admin/dataroom/documents/[documentId]/route.js
//
// DELETE /api/admin/dataroom/documents/:documentId — removes a document
// from the room. Does not unpin from Pinata (same "don't bother unpinning"
// posture as the rest of this codebase's IPFS usage) — just stops it from
// being listed/streamable to visitors.

import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "../../../../../../lib/admin-auth.js";
import { getDataroomCollections, toObjectId } from "../../../../../../lib/dataroom.js";

export const dynamic = "force-dynamic";

export async function DELETE(req, { params }) {
  if (!isAdminAuthenticated(req)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const { documentId } = params;
    const { documents } = await getDataroomCollections();
    await documents.deleteOne({ _id: toObjectId(documentId) });
    return NextResponse.json({ removed: true });
  } catch (err) {
    console.error("admin/dataroom/documents DELETE failed:", err);
    return NextResponse.json({ error: "Could not remove this document." }, { status: 500 });
  }
}
