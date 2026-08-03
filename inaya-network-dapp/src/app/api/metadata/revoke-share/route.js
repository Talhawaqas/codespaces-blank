// app/api/metadata/revoke-share/route.js
//
// POST /api/metadata/revoke-share
// Body: { fileHash, granteeAddress, address, message, signature, timestamp }
//
// Sets revokedAt on the grant record — get-shared-file-key filters these
// out, so this stops FUTURE getSharedFileKey() calls for that grantee.
// It cannot retroactively un-decrypt a passkey the grantee already
// fetched and cached locally before revocation — that's a fundamental
// property of any share-then-revoke scheme, documented in metadata.js's
// module comment and SDK_GUIDE.md, not something this route can close.

import { NextResponse } from "next/server";
import { connectToDatabase } from "../../../../lib/mongodb";
import { verifyMetadataAuth, verifyOnChainFileOwner } from "../../../../lib/metadata-auth";

export async function POST(req) {
  try {
    const { fileHash, granteeAddress, address, message, signature, timestamp } = await req.json();
    if (!fileHash || !granteeAddress) {
      return NextResponse.json({ error: "fileHash and granteeAddress are required." }, { status: 400 });
    }

    verifyMetadataAuth({ action: "revokeShare", resourceId: fileHash, extra: { granteeAddress }, address, message, signature, timestamp });
    await verifyOnChainFileOwner(fileHash, address);

    const { db } = await connectToDatabase();
    await db.collection("metadata_shares").updateOne(
      { fileHash, granteeAddress: granteeAddress.toLowerCase() },
      { $set: { revokedAt: new Date().toISOString() } }
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("metadata/revoke-share failed:", err);
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
}
