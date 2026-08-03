// app/api/metadata/register-file/route.js
//
// POST /api/metadata/register-file
// Body: { fileHash, filename, folderId, fileSizeBytes, address, message, signature, timestamp }
//
// Call right after anchorToLedger() succeeds. fileSizeBytes is stored as
// client-reported — the deployed InayaCustody contract's assets() getter
// doesn't expose the size it was written with (see src/lib/analytics.js
// in custody-sdk for the full explanation), so this route is the only
// place that number is ever recoverable from. It's covered by the same
// signature as filename/folderId (see metadata.js's registerFileMetadata()),
// so it can't be tampered with in transit, but it is NOT independently
// verified against on-chain state the way ownership is — Analytics
// documents this honestly rather than implying it's chain-verified.

import { NextResponse } from "next/server";
import { connectToDatabase } from "../../../../lib/mongodb";
import { verifyMetadataAuth, verifyOnChainFileOwner } from "../../../../lib/metadata-auth";

export async function POST(req) {
  try {
    const { fileHash, filename, folderId = null, fileSizeBytes, address, message, signature, timestamp } = await req.json();
    if (!fileHash || !filename) {
      return NextResponse.json({ error: "fileHash and filename are required." }, { status: 400 });
    }

    verifyMetadataAuth({ action: "registerFileMetadata", resourceId: fileHash, extra: { filename, folderId, fileSizeBytes }, address, message, signature, timestamp });
    await verifyOnChainFileOwner(fileHash, address);

    const { db } = await connectToDatabase();
    const now = new Date().toISOString();
    await db.collection("metadata_files").updateOne(
      { fileHash },
      {
        $set: {
          fileHash,
          owner: address.toLowerCase(),
          filename,
          folderId,
          fileSizeBytes: fileSizeBytes !== undefined ? Number(fileSizeBytes) : null,
          updatedAt: now,
          deletedAt: null,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true }
    );

    const record = await db.collection("metadata_files").findOne({ fileHash });
    return NextResponse.json(record);
  } catch (err) {
    console.error("metadata/register-file failed:", err);
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
}
