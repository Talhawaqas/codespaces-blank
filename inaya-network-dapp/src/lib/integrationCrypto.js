// src/lib/integrationCrypto.js
//
// Business Workspace Integrations Test SOW — reversible server-side
// encryption for real OAuth tokens (access/refresh tokens for Slack,
// Microsoft, Google, and org-provided OIDC/Okta client secrets). Same
// AES-256-GCM shape as src/lib/mfaCrypto.js's encryptSecret/decryptSecret
// (single opaque base64 string encoding iv+authTag+ciphertext), but with
// its OWN dedicated key (INTEGRATION_ENCRYPTION_KEY) rather than reusing
// MFA_ENCRYPTION_KEY — a compromise of one secret class should never
// automatically expose the other, same separate-keys-per-concern
// discipline custody-sdk's passkeyBackup.js already follows relative to
// mfaCrypto.js.
//
// INTEGRATION_ENCRYPTION_KEY must be a 32-byte key, base64-encoded, set
// once in .env.local / your deployment's env and never committed.
// Generate one with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

function getKey() {
  const keyB64 = process.env.INTEGRATION_ENCRYPTION_KEY;
  if (!keyB64) throw new Error("INTEGRATION_ENCRYPTION_KEY is not configured — no OAuth credential can be stored until it's set (32 random bytes, base64-encoded).");
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== 32) throw new Error("INTEGRATION_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  return key;
}

export function encryptIntegrationSecret(plaintext) {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

/** Throws (never returns garbage) if tampered or the key is wrong — GCM's
 *  auth tag check fails closed, same discipline as every other integrity
 *  check in this codebase. */
export function decryptIntegrationSecret(encoded) {
  const key = getKey();
  const raw = Buffer.from(encoded, "base64");
  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + 16);
  const ciphertext = raw.subarray(IV_LENGTH + 16);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function isIntegrationCryptoConfigured() {
  return !!process.env.INTEGRATION_ENCRYPTION_KEY;
}
