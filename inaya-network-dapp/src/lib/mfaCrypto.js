// src/lib/mfaCrypto.js
//
// Reversible server-side encryption for the TOTP secret ONLY. Confirmed
// (direct research this session) that nothing like this exists anywhere
// else in inaya-network-dapp — every other server-side "secret" here is
// one-way hashed (src/lib/orgs.js's hashToken, src/lib/admin-auth.js's
// sha256Hex), which is right for a session/magic-link token (never needs
// to be read back) but wrong for a TOTP secret (the server must decrypt
// it on every login to recompute the expected code). Shaped like
// custody-sdk/packages/cli/src/secretCrypto.js's AES-256-GCM algorithm,
// but keyed by a SERVER secret (MFA_ENCRYPTION_KEY, env-only) rather than
// a user-typed password — verification happens automatically server-side
// in this passwordless system, so there's no password to derive a key
// from at decrypt time.
//
// MFA_ENCRYPTION_KEY must be a 32-byte key, base64-encoded, set once in
// .env.local / your deployment's env and never committed. Generate one
// with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // GCM's recommended IV length

function getKey() {
  const keyB64 = process.env.MFA_ENCRYPTION_KEY;
  if (!keyB64) throw new Error("MFA_ENCRYPTION_KEY is not configured — MFA cannot be enabled until it's set (32 random bytes, base64-encoded).");
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== 32) throw new Error("MFA_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  return key;
}

/** Returns a single base64 string encoding iv + authTag + ciphertext, so callers store one
 *  opaque value per secret rather than three separate fields. */
export function encryptSecret(plaintext) {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

/** Throws (never returns a garbage string) if the ciphertext was tampered with or the key is
 *  wrong — GCM's auth tag check fails closed, same discipline every other integrity check in
 *  this codebase follows. */
export function decryptSecret(encoded) {
  const key = getKey();
  const raw = Buffer.from(encoded, "base64");
  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + 16);
  const ciphertext = raw.subarray(IV_LENGTH + 16);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
