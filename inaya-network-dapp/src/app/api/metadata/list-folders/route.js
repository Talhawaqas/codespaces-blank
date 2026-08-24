// app/api/metadata/list-folders/route.js
//
// GET /api/metadata/list-folders?owner=0x...&parentFolderId=...
//
// Read-only, not signature-gated -- same trust tier as list-files.
// parentFolderId omitted or absent means root-level folders (matching
// custody-sdk's metadata.js listFolders({parentFolderId: null}) default).

import { NextResponse } from "next/server";
import { connectToDatabase } from "../../../../lib/mongodb";

export async function GET(req) {
  const owner = req.nextUrl.searchParams.get("owner");
  const hasParent = req.nextUrl.searchParams.has("parentFolderId");
  const parentFolderId = hasParent ? req.nextUrl.searchParams.get("parentFolderId") : null;
  if (!owner) {
    return NextResponse.json({ error: "owner is required." }, { status: 400 });
  }

  const query = { owner: owner.toLowerCase(), parentFolderId, deletedAt: null };

  const { db } = await connectToDatabase();
  const folders = await db.collection("metadata_folders").find(query).toArray();

  return NextResponse.json({ folders });
}
