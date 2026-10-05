// src/lib/stepup.js
//
// Step-up authentication (DLP-002, REQUIRE_STRONGER_AUTH). A signed-in person who has an authenticator app enrolled (src/lib/mfa.js) proves it again with a fresh
// six-digit code; that opens a short window (STEP_UP_MINUTES) during which a data-loss rule that requires stronger authentication lets the action through.
//   * only a verified TOTP enrollment can step up; a person without one is told to enrol first, never waved through;
//   * the code is checked against the stored (decryptable) secret exactly like a login code, and wrong codes are counted: after MAX_FAILURES in a window the
//     person is locked out of step-up for LOCKOUT_MINUTES, which blunts brute force of a six-digit code;
//   * a code that has just been used cannot be replayed inside the same 30-second step;
//   * the window belongs to the e-mail address, expires by itself, and is recorded as a security event (never the code).

import { TOTP, Secret } from "otpauth";
import { connectToDatabase } from "./mongodb.js";
import { normalizeEmail } from "./orgs.js";
import { decryptSecret } from "./mfaCrypto.js";

export const STEP_UP_MINUTES = 10;
export const MAX_FAILURES = 5;
export const LOCKOUT_MINUTES = 15;
const nowMs = () => Date.now();

async function cols() {
  const { db } = await connectToDatabase(); const s = db.collection("step_ups");
  if (!cols.done) { await Promise.all([s.createIndex({ email: 1 }, { unique: true }), s.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 3600 })]); cols.done = true; }
  return { s, mfa: db.collection("member_mfa") };
}
const err = (status, code, message) => Object.assign(new Error(message), { status, code });

/** Confirms a fresh authenticator code and opens the step-up window. Throws a coded error otherwise. */
export async function grantStepUp({ email, code, now = nowMs() }) {
  const em = normalizeEmail(email); const { s, mfa } = await cols();
  const row = await s.findOne({ email: em });
  if (row?.lockedUntil && row.lockedUntil > now) throw err(429, "STEP_UP_LOCKED", "Too many wrong codes. Try again later.");
  const doc = await mfa.findOne({ _id: em });
  if (!doc?.totp?.verified) throw err(409, "MFA_NOT_ENROLLED", "Set up an authenticator app in your security settings first; stronger authentication needs it.");
  const token = String(code || "").trim();
  const totp = new TOTP({ issuer: "Inaya Network", label: em, algorithm: "SHA1", digits: 6, period: 30, secret: Secret.fromBase32(decryptSecret(doc.totp.secretEncrypted)) });
  const delta = /^\d{6}$/.test(token) ? totp.validate({ token, window: 1, timestamp: now }) : null;
  const step = delta === null ? null : Math.floor(now / 30000) + delta;
  if (step === null) {
    const failures = (row?.windowStart && now - row.windowStart < LOCKOUT_MINUTES * 60000 ? (row.failures || 0) : 0) + 1;
    await s.updateOne({ email: em }, { $set: { email: em, failures, windowStart: row?.windowStart && now - row.windowStart < LOCKOUT_MINUTES * 60000 ? row.windowStart : now, ...(failures >= MAX_FAILURES ? { lockedUntil: now + LOCKOUT_MINUTES * 60000, failures: 0 } : {}), expiresAt: new Date(now + 3600_000) } }, { upsert: true });
    throw err(401, "BAD_CODE", failures >= MAX_FAILURES ? "Too many wrong codes. Try again later." : "That code is not right. Check your authenticator app and try again.");
  }
  if (row?.lastStep != null && step <= row.lastStep) throw err(401, "CODE_REUSED", "That code was already used. Wait for the next one.");
  const expiresMs = now + STEP_UP_MINUTES * 60000;
  await s.updateOne({ email: em }, { $set: { email: em, at: now, until: expiresMs, lastStep: step, failures: 0, windowStart: null, lockedUntil: null, expiresAt: new Date(expiresMs + 3600_000) } }, { upsert: true });
  return { ok: true, until: new Date(expiresMs).toISOString(), minutes: STEP_UP_MINUTES };
}

/** True while this person's step-up window is open. */
export async function hasStepUp(email, now = nowMs()) {
  try { const { s } = await cols(); const row = await s.findOne({ email: normalizeEmail(email) }, { projection: { until: 1 } }); return !!row?.until && row.until > now; } catch { return false; }
}
