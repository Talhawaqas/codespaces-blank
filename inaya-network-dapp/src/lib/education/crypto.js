// src/lib/education/crypto.js
//
// Education OS — field-level encryption for student and guardian personal
// data (guardian phone/email/address, national identifiers, medical
// notes). Same AES-256-GCM shape as integrationCrypto.js (one base64
// string of iv + authTag + ciphertext), with its own key: EDUCATION_DATA_KEY
// (32 bytes, base64). When that isn't set, a key is derived with HKDF from
// INTEGRATION_ENCRYPTION_KEY under an education-only label, so a deployment
// works without a new secret while still never using the same key bytes
// for two kinds of data.

import { randomBytes, createCipheriv, createDecipheriv, hkdfSync } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const PREFIX = "edu1:";

let cachedKey = null;

function getKey() {
  if (cachedKey) return cachedKey;
  const own = process.env.EDUCATION_DATA_KEY;
  if (own) {
    const key = Buffer.from(own, "base64");
    if (key.length !== 32) throw new Error("EDUCATION_DATA_KEY must decode to exactly 32 bytes.");
    return (cachedKey = key);
  }
  const root = process.env.INTEGRATION_ENCRYPTION_KEY;
  if (!root) throw new Error("Neither EDUCATION_DATA_KEY nor INTEGRATION_ENCRYPTION_KEY is configured, so student personal data can't be stored encrypted.");
  const rootKey = Buffer.from(root, "base64");
  return (cachedKey = Buffer.from(hkdfSync("sha256", rootKey, Buffer.from("inaya-education"), Buffer.from("student-pii-v1"), 32)));
}

/** Encrypts a string; null/empty stays null so "no value" is never a ciphertext. */
export function sealField(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === "") return null;
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

/** Throws on tampering or a wrong key (GCM fails closed). */
export function openField(sealed) {
  if (!sealed) return null;
  if (!String(sealed).startsWith(PREFIX)) throw new Error("Not an Education OS sealed field.");
  const raw = Buffer.from(String(sealed).slice(PREFIX.length), "base64");
  const decipher = createDecipheriv(ALGORITHM, getKey(), raw.subarray(0, IV_LENGTH));
  decipher.setAuthTag(raw.subarray(IV_LENGTH, IV_LENGTH + 16));
  return Buffer.concat([decipher.update(raw.subarray(IV_LENGTH + 16)), decipher.final()]).toString("utf8");
}

export function sealJson(value) {
  return value === null || value === undefined ? null : sealField(JSON.stringify(value));
}

export function openJson(sealed) {
  const text = openField(sealed);
  return text === null ? null : JSON.parse(text);
}

/** For tests only: forget the cached key after changing env vars. */
export function _resetEducationKeyCache() {
  cachedKey = null;
}
