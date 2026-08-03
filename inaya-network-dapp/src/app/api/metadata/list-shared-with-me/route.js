// app/api/metadata/list-shared-with-me/route.js
//
// GET /api/metadata/list-shared-with-me?owner=0x...
//
// Read-only — lists every active (non-revoked) share granted TO `owner`
// by other wallets. `owner` here names the caller from the SDK's point
// of view (the person who owns this list), even though for a share
// record they're actually the grantee — matches custody-sdk's existing
// ListSharedWithMeParams shape exactly.

import { NextResponse } from "next/server";
import { connectToDatabase } from "../../../../lib/mongodb";

export async function GET(req) {
  const owner = req.nextUrl.searchParams.get("owner");
  if (!owner) {
    return NextResponse.json({ error: "owner is required." }, { status: 400 });
  }

  const { db } = await connectToDatabase();
  const records = await db
    .collection("metadata_shares")
    .find({ granteeAddress: owner.toLowerCase(), revokedAt: null })
    .toArray();

  const shares = records.map((r) => ({
    fileHash: r.fileHash,
    granterAddress: r.granterAddress,
    wrappedVaultKey: r.wrappedVaultKey,
    createdAt: r.createdAt,
  }));

  return NextResponse.json({ shares });
}
