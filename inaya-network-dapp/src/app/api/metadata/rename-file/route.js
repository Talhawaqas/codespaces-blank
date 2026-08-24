// app/api/metadata/rename-file/route.js
//
// POST /api/metadata/rename-file
// Body: { fileHash, newName, address, message, signature, timestamp }
//
// Renames a file's off-chain display name only — the on-chain fileHash
// and shards are untouched, matching custody-sdk's metadata.js comment
// on renameFile(). Same signature + on-chain-owner verification as
// register-file, since this mutates an existing metadata_files record.

import { NextResponse } from "next/server";
import { connectToDatabase } from "../../../../lib/mongodb";
import { verifyMetadataAuth, verifyOnChainFileOwner } from "../../../../lib/metadata-auth";

export async function POST(req) {
  try {
    const { fileHash, newName, address, message, signature, timestamp } = await req.json();
    if (!fileHash || !newName) {
      return NextResponse.json({ error: "fileHash and newName are required." }, { status: 400 });
    }

    verifyMetadataAuth({ action: "renameFile", resourceId: fileHash, extra: { newName }, address, message, signature, timestamp });
    await verifyOnChainFileOwner(fileHash, address);

    const { db } = await connectToDatabase();
    const result = await db.collection("metadata_files").findOneAndUpdate(
      { fileHash, owner: address.toLowerCase() },
      { $set: { filename: newName, updatedAt: new Date().toISOString() } },
      { returnDocument: "after" }
    );
    if (!result) {
      return NextResponse.json({ error: `No registered metadata found for fileHash "${fileHash}" — call registerFileMetadata() first.` }, { status: 404 });
    }

    return NextResponse.json(result);
  } catch (err) {
    console.error("metadata/rename-file failed:", err);
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
}
