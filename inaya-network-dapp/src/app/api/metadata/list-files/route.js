// app/api/metadata/list-files/route.js
//
// GET /api/metadata/list-files?owner=0x...&folderId=...&includeDeleted=false
//
// Read-only, not signature-gated (see metadata.js's module comment on
// read trust tiers). The sole enumeration source for "which files does
// this wallet have" — InayaCustody has no reverse index/enumeration
// function on-chain (assets(bytes32) only supports single-fileHash
// lookups), so this off-chain collection is the only place a full list
// can come from at all. Analytics cross-checks each returned fileHash
// against assets(fileHash) individually rather than trusting this list
// blindly — see custody-sdk's src/analytics.js for that reconciliation.

import { NextResponse } from "next/server";
import { connectToDatabase } from "../../../../lib/mongodb";

export async function GET(req) {
  const owner = req.nextUrl.searchParams.get("owner");
  const folderId = req.nextUrl.searchParams.get("folderId");
  const includeDeleted = req.nextUrl.searchParams.get("includeDeleted") === "true";
  if (!owner) {
    return NextResponse.json({ error: "owner is required." }, { status: 400 });
  }

  const query = { owner: owner.toLowerCase() };
  if (folderId !== null) query.folderId = folderId;
  if (!includeDeleted) query.deletedAt = null;

  const { db } = await connectToDatabase();
  const files = await db.collection("metadata_files").find(query).toArray();

  return NextResponse.json({ files });
}
