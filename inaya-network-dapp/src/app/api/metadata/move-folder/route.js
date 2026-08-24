// app/api/metadata/move-folder/route.js
//
// POST /api/metadata/move-folder
// Body: { folderId, parentFolderId, address, message, signature, timestamp }
//
// Guards the one cheap cycle case (moving a folder directly into itself).
// Deeper cycles -- moving a folder into one of its own descendants --
// are NOT detected here; that needs a full tree walk this route doesn't
// do. Flagging honestly rather than implying full cycle-safety: a
// misused deep move would orphan a subtree from the root view, not
// corrupt data, since deletion still targets exact folderIds.

import { NextResponse } from "next/server";
import { connectToDatabase } from "../../../../lib/mongodb";
import { verifyMetadataAuth, verifyDbFolderOwner } from "../../../../lib/metadata-auth";

export async function POST(req) {
  try {
    const { folderId, parentFolderId = null, address, message, signature, timestamp } = await req.json();
    if (!folderId) {
      return NextResponse.json({ error: "folderId is required." }, { status: 400 });
    }
    if (parentFolderId === folderId) {
      return NextResponse.json({ error: "A folder cannot be moved into itself." }, { status: 400 });
    }

    verifyMetadataAuth({ action: "moveFolder", resourceId: folderId, extra: { parentFolderId }, address, message, signature, timestamp });

    const { db } = await connectToDatabase();
    await verifyDbFolderOwner(db, folderId, address);
    if (parentFolderId !== null) {
      await verifyDbFolderOwner(db, parentFolderId, address);
    }

    const result = await db.collection("metadata_folders").findOneAndUpdate(
      { folderId },
      { $set: { parentFolderId, updatedAt: new Date().toISOString() } },
      { returnDocument: "after" }
    );

    return NextResponse.json(result);
  } catch (err) {
    console.error("metadata/move-folder failed:", err);
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
}
