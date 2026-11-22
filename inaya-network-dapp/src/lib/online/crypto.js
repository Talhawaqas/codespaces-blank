// src/lib/online/crypto.js -- Online Commerce (Master SOW 9.5 / 9.8): the shop's OWN payment-provider and store-connector
// credentials (Stripe secret key, Safepay secret, Shopify access token, WooCommerce consumer secret, webhook secrets) are
// stored only sealed with AES-256-GCM. The key is derived with HKDF from INTEGRATION_ENCRYPTION_KEY under an online-commerce
// label, so these bytes never share a key with any other kind of data. Secrets are never returned to the browser: views
// show only the last 4 characters.
import { randomBytes, createCipheriv, createDecipheriv, hkdfSync, timingSafeEqual } from "node:crypto";

const PREFIX = "onl1:";
let cachedKey = null;
function getKey() {
  if (cachedKey) return cachedKey;
  const root = process.env.INTEGRATION_ENCRYPTION_KEY;
  if (!root) throw new Error("INTEGRATION_ENCRYPTION_KEY is not configured, so store and payment credentials can't be stored.");
  return (cachedKey = Buffer.from(hkdfSync("sha256", Buffer.from(root, "base64"), Buffer.from("inaya-online-commerce"), Buffer.from("online-credentials-v1"), 32)));
}

export function seal(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === "") return null;
  const iv = randomBytes(12); const c = createCipheriv("aes-256-gcm", getKey(), iv);
  const ct = Buffer.concat([c.update(String(plaintext), "utf8"), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}
export function open(sealed) {
  if (!sealed) return null;
  if (!String(sealed).startsWith(PREFIX)) throw new Error("Not an online-commerce sealed field.");
  const raw = Buffer.from(String(sealed).slice(PREFIX.length), "base64");
  const d = createDecipheriv("aes-256-gcm", getKey(), raw.subarray(0, 12)); d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
}
export function openSafe(sealed) { try { return open(sealed); } catch { return null; } }
export const last4 = (s) => (s ? `…${String(s).slice(-4)}` : null);
/** Constant-time comparison of two strings (signatures). */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a || "")); const y = Buffer.from(String(b || ""));
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}
export function _resetOnlineKeyCache() { cachedKey = null; }
