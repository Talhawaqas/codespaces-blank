// app/api/metadata/get-encryption-key/route.js
//
// GET /api/metadata/get-encryption-key?address=0x...
//
// Read-only, not signature-gated (same trust tier as list-shared-with-me
// and every other Metadata read) — the stored value is a PUBLIC key by
// definition, safe for anyone to look up. Returns { publicKey: null }
// rather than a 404 when unregistered, so custody-sdk's shareFile() can
// branch on it cleanly instead of catching an HTTP error.

import { NextResponse } from "next/server";
import { connectToDatabase } from "../../../../lib/mongodb";

export async function GET(req) {
  const address = req.nextUrl.searchParams.get("address");
  if (!address) {
    return NextResponse.json({ error: "address is required." }, { status: 400 });
  }

  const { db } = await connectToDatabase();
  const record = await db.collection("metadata_encryption_keys").findOne({ address: address.toLowerCase() });

  return NextResponse.json({ publicKey: record?.publicKey ?? null });
}
