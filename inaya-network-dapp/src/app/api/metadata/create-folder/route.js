// app/api/metadata/create-folder/route.js
//
// POST /api/metadata/create-folder
// Body: { name, parentFolderId, address, message, signature, timestamp }
//
// Virtual folders are a pure off-chain construct -- no on-chain anchor at
// all (see custody-sdk's metadata.js module comment), so ownership here
// is only ever whatever this collection records at creation time. The
// signed action's resourceId is parentFolderId ?? "root", matching
// exactly what metadata.js's createFolder() signs client-side.

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { connectToDatabase } from "../../../../lib/mongodb";
import { verifyMetadataAuth, verifyDbFolderOwner } from "../../../../lib/metadata-auth";

export async function POST(req) {
  try {
    const { name, parentFolderId = null, address, message, signature, timestamp } = await req.json();
    if (!name) {
      return NextResponse.json({ error: "name is required." }, { status: 400 });
    }

    verifyMetadataAuth({ action: "createFolder", resourceId: parentFolderId ?? "root", extra: { name }, address, message, signature, timestamp });

    const { db } = await connectToDatabase();

    // A non-root parent must actually exist and belong to this caller --
    // otherwise a folder could be created "inside" someone else's tree.
    if (parentFolderId !== null) {
      await verifyDbFolderOwner(db, parentFolderId, address);
    }

    const folderId = randomUUID();
    const now = new Date().toISOString();
    const doc = {
      folderId,
      owner: address.toLowerCase(),
      name,
      parentFolderId,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    await db.collection("metadata_folders").insertOne(doc);

    return NextResponse.json(doc);
  } catch (err) {
    console.error("metadata/create-folder failed:", err);
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
}
