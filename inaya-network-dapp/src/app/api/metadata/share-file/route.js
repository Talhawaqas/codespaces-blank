// app/api/metadata/share-file/route.js
//
// POST /api/metadata/share-file
// Body: { fileHash, granteeAddress, wrappedVaultKey, address, message, signature, timestamp }
//
// wrappedVaultKey arrives already encrypted (custody-sdk's shareFile()
// does that client-side via crypto.js's encryptForPublicKey() before this
// route is ever called) — this route only verifies the caller actually
// owns fileHash on-chain, then stores the opaque blob verbatim. It never
// inspects, decrypts, or could decrypt wrappedVaultKey even if it wanted
// to; only the grantee's locally-derived secretKey can.

import { NextResponse } from "next/server";
import { connectToDatabase } from "../../../../lib/mongodb";
import { verifyMetadataAuth, verifyOnChainFileOwner } from "../../../../lib/metadata-auth";

export async function POST(req) {
  try {
    const { fileHash, granteeAddress, wrappedVaultKey, address, message, signature, timestamp } = await req.json();
    if (!fileHash || !granteeAddress || !wrappedVaultKey) {
      return NextResponse.json({ error: "fileHash, granteeAddress, and wrappedVaultKey are all required." }, { status: 400 });
    }

    verifyMetadataAuth({ action: "shareFile", resourceId: fileHash, extra: { granteeAddress }, address, message, signature, timestamp });
    await verifyOnChainFileOwner(fileHash, address);

    const { db } = await connectToDatabase();
    await db.collection("metadata_shares").updateOne(
      { fileHash, granteeAddress: granteeAddress.toLowerCase() },
      {
        $set: {
          fileHash,
          granterAddress: address.toLowerCase(),
          granteeAddress: granteeAddress.toLowerCase(),
          wrappedVaultKey,
          revokedAt: null,
        },
        $setOnInsert: { createdAt: new Date().toISOString() },
      },
      { upsert: true }
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("metadata/share-file failed:", err);
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
}
