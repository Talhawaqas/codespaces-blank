// app/api/metadata/delete-folder/route.js
//
// POST /api/metadata/delete-folder
// Body: { folderId, address, message, signature, timestamp }
//
// Soft-deletes a folder. Deliberately does NOT cascade-delete contained
// files -- per custody-sdk's metadata.js deleteFolder() comment, files
// inside get orphaned back to root (folderId: null) instead, keeping the
// two resource types' delete semantics independent. Direct child folders
// are orphaned to root the same way, so nothing is left pointing at a
// deleted parent.

import { NextResponse } from "next/server";
import { connectToDatabase } from "../../../../lib/mongodb";
import { verifyMetadataAuth, verifyDbFolderOwner } from "../../../../lib/metadata-auth";

export async function POST(req) {
  try {
    const { folderId, address, message, signature, timestamp } = await req.json();
    if (!folderId) {
      return NextResponse.json({ error: "folderId is required." }, { status: 400 });
    }

    verifyMetadataAuth({ action: "deleteFolder", resourceId: folderId, address, message, signature, timestamp });

    const { db } = await connectToDatabase();
    await verifyDbFolderOwner(db, folderId, address);

    const now = new Date().toISOString();
    const result = await db.collection("metadata_folders").findOneAndUpdate(
      { folderId },
      { $set: { deletedAt: now, updatedAt: now } },
      { returnDocument: "after" }
    );

    await db.collection("metadata_files").updateMany(
      { folderId, owner: address.toLowerCase() },
      { $set: { folderId: null, updatedAt: now } }
    );
    await db.collection("metadata_folders").updateMany(
      { parentFolderId: folderId, owner: address.toLowerCase() },
      { $set: { parentFolderId: null, updatedAt: now } }
    );

    return NextResponse.json(result);
  } catch (err) {
    console.error("metadata/delete-folder failed:", err);
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
}
