// app/api/metadata/register-encryption-key/route.js
//
// POST /api/metadata/register-encryption-key
// Body: { publicKey, address, message, signature, timestamp }
//
// Stores a wallet's deterministic X25519 sharing public key (see
// custody-sdk's Metadata.registerEncryptionKey()) so other wallets can
// look it up via get-encryption-key before calling shareFile(). Not a
// file action — resourceId is the caller's own address, so there's no
// on-chain owner to cross-check; the signature alone is the proof
// (self-registration, same trust tier as createFolder()).
//
// Idempotent: registering again just overwrites the stored key with
// whatever the (deterministic) derivation produces — always the same
// value for the same wallet, so this never actually changes anything
// in practice, but upsert keeps re-registration cheap and side-effect-free.

import { NextResponse } from "next/server";
import { connectToDatabase } from "../../../../lib/mongodb";
import { verifyMetadataAuth } from "../../../../lib/metadata-auth";

export async function POST(req) {
  try {
    const { publicKey, address, message, signature, timestamp } = await req.json();
    if (!publicKey) {
      return NextResponse.json({ error: "publicKey is required." }, { status: 400 });
    }

    verifyMetadataAuth({ action: "registerEncryptionKey", resourceId: address, extra: { publicKey }, address, message, signature, timestamp });

    const { db } = await connectToDatabase();
    await db.collection("metadata_encryption_keys").updateOne(
      { address: address.toLowerCase() },
      { $set: { address: address.toLowerCase(), publicKey, updatedAt: new Date().toISOString() } },
      { upsert: true }
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("metadata/register-encryption-key failed:", err);
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
}
