// app/api/admin/dataroom/documents/[documentId]/route.js
//
// DELETE /api/admin/dataroom/documents/:documentId — removes a document
// from the room AND its bytes from GridFS — unlike the old "don't bother
// unpinning" IPFS posture, this is real database storage, so an admin
// delete should actually free it rather than leave an orphaned file.

import { NextResponse } from "next/server";
import { isAdminAuthenticated } from "../../../../../../lib/admin-auth.js";
import { getDataroomCollections, toObjectId, deleteDocumentFile, deleteVideoFile } from "../../../../../../lib/dataroom.js";

export const dynamic = "force-dynamic";

export async function DELETE(req, { params }) {
  if (!isAdminAuthenticated(req)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const { documentId } = params;
    const { documents } = await getDataroomCollections();
    const doc = await documents.findOne({ _id: toObjectId(documentId) });
    if (doc?.storageType === "blob" && doc.blobPathname) {
      await deleteVideoFile(doc.blobPathname).catch((err) => {
        // A missing/already-gone blob shouldn't block removing the row
        // itself — log and continue, same fail-open posture GridFS cleanup
        // below uses.
        console.error(`admin/dataroom/documents DELETE: Blob cleanup failed for pathname ${doc.blobPathname}:`, err.message);
      });
    } else if (doc?.fileId) {
      await deleteDocumentFile(doc.fileId).catch((err) => {
        console.error(`admin/dataroom/documents DELETE: GridFS cleanup failed for fileId ${doc.fileId}:`, err.message);
      });
    }
    await documents.deleteOne({ _id: toObjectId(documentId) });
    return NextResponse.json({ removed: true });
  } catch (err) {
    console.error("admin/dataroom/documents DELETE failed:", err);
    return NextResponse.json({ error: "Could not remove this document." }, { status: 500 });
  }
}
