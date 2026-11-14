// src/lib/engagement/crypto.js
//
// Appointments & Campaigns SOW — field-level encryption for customer
// personal data held by the calendar and marketing modules (phone numbers
// used for SMS reminders, private meeting notes, calendar-import URLs, which
// are secrets because anyone with the URL can read that calendar).
// AES-256-GCM, key derived with HKDF from INTEGRATION_ENCRYPTION_KEY under
// an engagement-only label, so these bytes are never shared with another
// kind of data. Optional ENGAGEMENT_DATA_KEY (32 bytes, base64) overrides.

import { randomBytes, createCipheriv, createDecipheriv, hkdfSync } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const PREFIX = "eng1:";
let cachedKey = null;

function getKey() {
  if (cachedKey) return cachedKey;
  const own = process.env.ENGAGEMENT_DATA_KEY;
  if (own) {
    const key = Buffer.from(own, "base64");
    if (key.length !== 32) throw new Error("ENGAGEMENT_DATA_KEY must decode to exactly 32 bytes.");
    return (cachedKey = key);
  }
  const root = process.env.INTEGRATION_ENCRYPTION_KEY;
  if (!root) throw new Error("INTEGRATION_ENCRYPTION_KEY is not configured, so appointment notes and phone numbers can't be stored encrypted.");
  return (cachedKey = Buffer.from(hkdfSync("sha256", Buffer.from(root, "base64"), Buffer.from("inaya-engagement"), Buffer.from("engagement-pii-v1"), 32)));
}

export function seal(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === "") return null;
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

export function open(sealed) {
  if (!sealed) return null;
  if (!String(sealed).startsWith(PREFIX)) throw new Error("Not an engagement sealed field.");
  const raw = Buffer.from(String(sealed).slice(PREFIX.length), "base64");
  const d = createDecipheriv(ALGORITHM, getKey(), raw.subarray(0, IV_LENGTH));
  d.setAuthTag(raw.subarray(IV_LENGTH, IV_LENGTH + 16));
  return Buffer.concat([d.update(raw.subarray(IV_LENGTH + 16)), d.final()]).toString("utf8");
}

/** open() that returns null instead of throwing (a rotated key must not break a list view). */
export function openSafe(sealed) {
  try { return open(sealed); } catch { return null; }
}

/** For tests only. */
export function _resetEngagementKeyCache() { cachedKey = null; }
