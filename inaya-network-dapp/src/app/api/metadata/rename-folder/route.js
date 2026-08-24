// app/api/metadata/rename-folder/route.js
//
// POST /api/metadata/rename-folder
// Body: { folderId, newName, address, message, signature, timestamp }

import { NextResponse } from "next/server";
import { connectToDatabase } from "../../../../lib/mongodb";
import { verifyMetadataAuth, verifyDbFolderOwner } from "../../../../lib/metadata-auth";

export async function POST(req) {
  try {
    const { folderId, newName, address, message, signature, timestamp } = await req.json();
    if (!folderId || !newName) {
      return NextResponse.json({ error: "folderId and newName are required." }, { status: 400 });
    }

    verifyMetadataAuth({ action: "renameFolder", resourceId: folderId, extra: { newName }, address, message, signature, timestamp });

    const { db } = await connectToDatabase();
    await verifyDbFolderOwner(db, folderId, address);

    const result = await db.collection("metadata_folders").findOneAndUpdate(
      { folderId },
      { $set: { name: newName, updatedAt: new Date().toISOString() } },
      { returnDocument: "after" }
    );

    return NextResponse.json(result);
  } catch (err) {
    console.error("metadata/rename-folder failed:", err);
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
}
