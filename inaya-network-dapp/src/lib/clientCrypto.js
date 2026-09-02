"use client";

// src/lib/clientCrypto.js
//
// The client-side encrypt/shard/pin pipeline, consolidated. Originally the exact same
// four pure functions (encryptData, readFileAsDataURL, uploadShardToPinata, sha256Hex)
// were independently duplicated three times — business/page.js's DocumentColumn,
// FinanceView.js's receipt upload, HRView.js's employee-document upload — then extracted
// here as a first consolidation pass.
//
// Verifiable Inaya Client SOW: the encryption itself (PBKDF2 100k SHA-256 -> AES-GCM-256,
// midpoint shard split) now delegates to @inaya-network/custody-sdk's
// deriveVaultKey/disperseAndSlice instead of a hand-rolled crypto.subtle copy — this file
// was one of two independent implementations of the same algorithm inside this dApp
// (the other, src/app/page.js's own inline copy, was consolidated the same way). Proven
// byte-identical to the old implementation before this switch, via a committed
// cross-compatibility test (custody-sdk/test/webCryptoCompat.test.mjs) — not assumed.
// uploadShardToPinata/sha256Hex are unrelated to the SDK swap and unchanged.

import { InayaKernel } from "@inaya-network/custody-sdk";

export async function uploadShardToPinata(encryptedShard, filename, elementTag) {
  const res = await fetch("/api/upload", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ encryptedShard, filename, elementTag }) });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || data.pinata || "IPFS pinning failed.");
  return data.IpfsHash;
}

export async function sha256Hex(text) {
  const enc = new TextEncoder();
  const digest = await window.crypto.subtle.digest("SHA-256", enc.encode(text));
  return "0x" + Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The full pipeline in one call — encrypt, hash, split, pin both shards
 *  in parallel. Returns exactly the fields every call site needs to POST
 *  to its own metadata-recording route: {fileHash, sizeBytes, cidAlpha,
 *  cidBeta}. sizeBytes is the ORIGINAL file's size (what every existing
 *  call site records), not the encrypted/shard size. */
export async function encryptAndShardFile(file, passkey) {
  const salt = InayaKernel.generateSecureSalt();
  const encryptionKey = await InayaKernel.deriveVaultKey({ passkey, salt });
  const { shardAlpha, shardBeta } = await InayaKernel.disperseAndSlice({ file, encryptionKey });
  // fileHash is over the FULL pre-split ciphertext, matching every existing caller's
  // already-recorded hashes — disperseAndSlice() returns the two halves pre-split, so
  // reconstruct the whole string the same way the old implementation always produced it.
  const fileHash = await sha256Hex(shardAlpha + shardBeta);
  const [cidAlpha, cidBeta] = await Promise.all([
    uploadShardToPinata(shardAlpha, file.name, "Alpha"),
    uploadShardToPinata(shardBeta, file.name, "Beta"),
  ]);
  return { fileHash, sizeBytes: file.size, cidAlpha, cidBeta };
}
