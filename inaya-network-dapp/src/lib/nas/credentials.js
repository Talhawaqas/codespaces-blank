// src/lib/nas/credentials.js
//
// Sovereign NAS SOW. Envelope encryption for NAS appliance connection
// secrets (the agent's admin credential used to provision shares/users on
// the appliance) -- same AES-256-GCM envelope shape as every other secret
// class in this codebase (backupCryptoAndCredentials.js,
// legacyDataAccess/credentials.js): iv+authTag+ciphertext packed into one
// base64 string, and its OWN dedicated key (NAS_ENCRYPTION_KEY) per this
// codebase's "one key per secret class" rule -- a compromise of the
// legacy-data-access or backup key must never expose a NAS appliance's
// admin credential, and vice versa.
//
// NAS_ENCRYPTION_KEY must be a 32-byte key, base64-encoded, set once in
// .env.local / your deployment's env and never committed. Generate:
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

function getKey() {
  const keyB64 = process.env.NAS_ENCRYPTION_KEY;
  if (!keyB64) throw new Error("NAS_ENCRYPTION_KEY is not configured — no NAS appliance credential can be stored until it's set (32 random bytes, base64-encoded).");
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== 32) throw new Error("NAS_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  return key;
}

export function isNasCredentialCryptoConfigured() {
  try {
    getKey();
    return true;
  } catch {
    return false;
  }
}

export function encryptNasSecret(plaintext) {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

/** Throws (never returns garbage) if tampered or the key is wrong -- GCM's
 *  auth tag check fails closed, same discipline as every other secret
 *  class in this codebase. */
export function decryptNasSecret(encoded) {
  const key = getKey();
  const raw = Buffer.from(encoded, "base64");
  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + 16);
  const ciphertext = raw.subarray(IV_LENGTH + 16);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
