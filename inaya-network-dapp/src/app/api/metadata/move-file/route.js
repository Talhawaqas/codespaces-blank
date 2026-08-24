// app/api/metadata/move-file/route.js
//
// POST /api/metadata/move-file
// Body: { fileHash, folderId, address, message, signature, timestamp }
//
// Moves a file into a different virtual folder. folderId: null moves it
// back to root, matching custody-sdk's metadata.js moveFile() comment.
// Deliberately does NOT verify folderId itself exists/belongs to the
// caller here -- the SDK's createFolder() already scopes folder creation
// per-owner, and a file "moved" into a nonexistent/foreign folderId just
// won't show up under listFiles({folderId}) for anyone, the same
// fail-safe (not fail-open) behavior as a typo'd folderId.

import { NextResponse } from "next/server";
import { connectToDatabase } from "../../../../lib/mongodb";
import { verifyMetadataAuth, verifyOnChainFileOwner } from "../../../../lib/metadata-auth";

export async function POST(req) {
  try {
    const { fileHash, folderId = null, address, message, signature, timestamp } = await req.json();
    if (!fileHash) {
      return NextResponse.json({ error: "fileHash is required." }, { status: 400 });
    }

    verifyMetadataAuth({ action: "moveFile", resourceId: fileHash, extra: { folderId }, address, message, signature, timestamp });
    await verifyOnChainFileOwner(fileHash, address);

    const { db } = await connectToDatabase();
    const result = await db.collection("metadata_files").findOneAndUpdate(
      { fileHash, owner: address.toLowerCase() },
      { $set: { folderId, updatedAt: new Date().toISOString() } },
      { returnDocument: "after" }
    );
    if (!result) {
      return NextResponse.json({ error: `No registered metadata found for fileHash "${fileHash}" — call registerFileMetadata() first.` }, { status: 404 });
    }

    return NextResponse.json(result);
  } catch (err) {
    console.error("metadata/move-file failed:", err);
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
}
