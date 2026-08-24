// app/api/metadata/delete-file/route.js
//
// POST /api/metadata/delete-file
// Body: { fileHash, address, message, signature, timestamp }
//
// Soft-deletes a file's metadata (sets deletedAt) -- hides it from
// listFiles() by default. The on-chain record is permanent by design;
// this never touches the chain or the shards themselves, and the file
// can still be retrieved directly via retrieveAndReconstruct() if someone
// already has the fileHash, exactly as custody-sdk's metadata.js
// deleteFile() comment documents. Call restore-file to undo.

import { NextResponse } from "next/server";
import { connectToDatabase } from "../../../../lib/mongodb";
import { verifyMetadataAuth, verifyOnChainFileOwner } from "../../../../lib/metadata-auth";

export async function POST(req) {
  try {
    const { fileHash, address, message, signature, timestamp } = await req.json();
    if (!fileHash) {
      return NextResponse.json({ error: "fileHash is required." }, { status: 400 });
    }

    verifyMetadataAuth({ action: "deleteFile", resourceId: fileHash, address, message, signature, timestamp });
    await verifyOnChainFileOwner(fileHash, address);

    const { db } = await connectToDatabase();
    const result = await db.collection("metadata_files").findOneAndUpdate(
      { fileHash, owner: address.toLowerCase() },
      { $set: { deletedAt: new Date().toISOString() } },
      { returnDocument: "after" }
    );
    if (!result) {
      return NextResponse.json({ error: `No registered metadata found for fileHash "${fileHash}" — call registerFileMetadata() first.` }, { status: 404 });
    }

    return NextResponse.json(result);
  } catch (err) {
    console.error("metadata/delete-file failed:", err);
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
}
