// app/api/metadata/get-shared-file-key/route.js
//
// GET /api/metadata/get-shared-file-key?fileHash=...&granteeAddress=0x...
//
// Read-only, not signature-gated: the stored wrappedVaultKey is already
// ciphertext, encrypted specifically for granteeAddress's registered
// public key (see share-file/route.js) — exposing it to anyone who
// knows the fileHash+granteeAddress pair is safe, the same way an
// encrypted IPFS shard is safe to expose. Only the real grantee's
// locally-derived secretKey (from their own wallet signature) can
// actually decrypt it. Returns { wrappedVaultKey: null } for "no active
// share" (never granted, or revoked) rather than a 404, so custody-sdk's
// getSharedFileKey() can distinguish that from a real transport error.

import { NextResponse } from "next/server";
import { connectToDatabase } from "../../../../lib/mongodb";

export async function GET(req) {
  const fileHash = req.nextUrl.searchParams.get("fileHash");
  const granteeAddress = req.nextUrl.searchParams.get("granteeAddress");
  if (!fileHash || !granteeAddress) {
    return NextResponse.json({ error: "fileHash and granteeAddress are required." }, { status: 400 });
  }

  const { db } = await connectToDatabase();
  const record = await db.collection("metadata_shares").findOne({
    fileHash,
    granteeAddress: granteeAddress.toLowerCase(),
    revokedAt: null,
  });

  return NextResponse.json({ wrappedVaultKey: record?.wrappedVaultKey ?? null });
}
