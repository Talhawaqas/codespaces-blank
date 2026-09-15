// src/lib/s3-compat/crypto.js
//
// Envelope-wraps the per-org passphrase used by the S3/Azure compatibility
// layer's server-managed encryption. Same shape as src/lib/mfaCrypto.js
// (AES-256-GCM, server-only key, iv+authTag+ciphertext packed into one
// base64 string) -- deliberately not refactored into a shared helper so
// each secret's own file stays a single, auditable unit, matching this
// repo's existing convention of one crypto file per secret type rather
// than one generic "encrypt anything" utility.
//
// What this wraps is NOT the AES-GCM key that actually encrypts a file --
// it wraps the *passphrase* string that gets fed to custody-sdk's own
// deriveVaultKey()/disperseAndSlice()/reconstructAndDecrypt(), so every
// object written through this compatibility layer is encrypted with the
// exact same real, audited crypto primitives Inaya already uses for every
// other file -- never a parallel, invented encryption scheme.
//
// S3_COMPAT_ENCRYPTION_KEY must be 32 random bytes, base64-encoded, set
// once in .env.local / the deployment's env and never committed. Generate
// with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

function getMasterKey() {
  const keyB64 = process.env.S3_COMPAT_ENCRYPTION_KEY;
  if (!keyB64) throw new Error("S3_COMPAT_ENCRYPTION_KEY is not configured -- the S3/Azure compatibility layer cannot operate until it's set (32 random bytes, base64-encoded).");
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== 32) throw new Error("S3_COMPAT_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  return key;
}

/** Generates a fresh, high-entropy passphrase for a new org's compatibility-layer
 *  credential -- this is what ends up wrapped and stored, and unwrapped-then-fed
 *  to deriveVaultKey() on every object read/write. 48 random bytes, base64, well
 *  beyond disperseAndSlice()'s own PBKDF2 iteration count makes brute-force moot. */
export function generatePassphrase() {
  return randomBytes(48).toString("base64");
}

/** Returns a single base64 string encoding iv + authTag + ciphertext. */
export function wrapPassphrase(plaintext) {
  const key = getMasterKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

/** Throws (never returns a garbage string) if the ciphertext was tampered with or the
 *  key is wrong -- GCM's auth tag check fails closed, same discipline as mfaCrypto.js. */
export function unwrapPassphrase(encoded) {
  const key = getMasterKey();
  const raw = Buffer.from(encoded, "base64");
  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + 16);
  const ciphertext = raw.subarray(IV_LENGTH + 16);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
