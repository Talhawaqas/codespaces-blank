// src/lib/mfa.js
//
// MFA for Business Workspace logins — identity-scoped (by email), not
// org-scoped: one enrollment protects every org a person belongs to,
// matching how consumeLoginToken()/createSession() already work
// (email-first, org-membership checked per request afterward, see
// orgs.js's module comment). Two methods: TOTP (QR code — Google
// Authenticator, Authy, or any RFC 6238 app all work the same way) and
// SMS. `member_mfa` (one doc per email) tracks enrollment; `mfa_pending`
// (mirrors magic_links' hash+expiry shape) tracks in-flight logins
// waiting on a second factor.
//
// SECURITY: the TOTP secret is the only thing that needs to stay
// server-decryptable (mfaCrypto.js, AES-256-GCM) — everything else here
// (recovery codes, SMS OTPs, pending tokens) is one-way hashed via
// orgs.js's existing hashToken(), the same minimal-trust convention
// every other token in this codebase already follows. A pending login's
// attempt counter caps at MAX_VERIFY_ATTEMPTS (5) before the token is
// invalidated outright — a 6-digit code is only 1-in-1,000,000, so this
// is the control that actually matters against brute force.

import { randomBytes } from "node:crypto";
import { TOTP, Secret } from "otpauth";
import QRCode from "qrcode";
import { connectToDatabase } from "./mongodb.js";
import { hashToken, generateToken, normalizeEmail } from "./orgs.js";
import { verifyPhoneIdToken } from "./firebaseAdmin.js";
import { encryptSecret, decryptSecret } from "./mfaCrypto.js";

const ISSUER = "Inaya Network";
const MFA_PENDING_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_VERIFY_ATTEMPTS = 5;
const RECOVERY_CODE_COUNT = 10;

async function collections() {
  const { db } = await connectToDatabase();
  return { memberMfa: db.collection("member_mfa"), mfaPending: db.collection("mfa_pending") };
}

function buildTotp(secretBase32, email) {
  return new TOTP({ issuer: ISSUER, label: email, algorithm: "SHA1", digits: 6, period: 30, secret: Secret.fromBase32(secretBase32) });
}

function generateRecoveryCodes() {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => randomBytes(5).toString("hex")); // 10-char codes
  return { codes, hashed: codes.map(hashToken) };
}

/** Never returns secrets — safe to expose to the client as-is. */
export async function getMfaStatus(email) {
  const { memberMfa } = await collections();
  const doc = await memberMfa.findOne({ _id: normalizeEmail(email) });
  return {
    totpEnabled: !!doc?.totp?.verified,
    smsEnabled: !!doc?.sms?.verified,
    smsPhoneLast4: doc?.sms?.verified ? doc.sms.phoneNumber.slice(-4) : null,
    hasRecoveryCodes: Array.isArray(doc?.recoveryCodesHashed) && doc.recoveryCodesHashed.length > 0,
  };
}

/** Used by the login routes — true if EITHER method is fully verified (not just pending enrollment). */
export async function isMfaEnrolled(email) {
  const status = await getMfaStatus(email);
  return status.totpEnabled || status.smsEnabled;
}

// ============================================================
// TOTP enrollment
// ============================================================

/** Generates a new secret, stores it encrypted as verified:false (pending confirmTotp()).
 *  Returns the otpauth:// URI and a scannable QR code data URI — the RAW base32 secret is also
 *  returned once here so an authenticator app can be set up by manual entry as a fallback to
 *  scanning, but it is NEVER stored in plaintext (encryptSecret() below) or logged. */
export async function enrollTotp(email) {
  const normalized = normalizeEmail(email);
  const secret = new Secret({ size: 20 });
  const totp = buildTotp(secret.base32, normalized);
  const uri = totp.toString();
  const qrDataUri = await QRCode.toDataURL(uri);

  const { memberMfa } = await collections();
  await memberMfa.updateOne(
    { _id: normalized },
    { $set: { totp: { secretEncrypted: encryptSecret(secret.base32), verified: false, enrolledAt: new Date().toISOString() } } },
    { upsert: true }
  );

  return { secret: secret.base32, uri, qrDataUri };
}

/** Verifies the first real code from the authenticator app, flips verified:true. Issues
 *  recovery codes ONLY if this account has none yet (adding a second method later doesn't
 *  regenerate — one set of recovery codes covers the whole account). */
export async function confirmTotp(email, code) {
  const normalized = normalizeEmail(email);
  const { memberMfa } = await collections();
  const doc = await memberMfa.findOne({ _id: normalized });
  if (!doc?.totp || doc.totp.verified) throw new Error("No pending TOTP enrollment for this account — call enrollTotp() first.");

  const secretBase32 = decryptSecret(doc.totp.secretEncrypted);
  const totp = buildTotp(secretBase32, normalized);
  if (totp.validate({ token: String(code || "").trim(), window: 1 }) === null) {
    throw new Error("That code doesn't match — check your authenticator app and try again.");
  }

  const update = { $set: { "totp.verified": true } };
  let recoveryCodes = null;
  if (!doc.recoveryCodesHashed?.length) {
    const generated = generateRecoveryCodes();
    update.$set.recoveryCodesHashed = generated.hashed;
    recoveryCodes = generated.codes;
  }
  await memberMfa.updateOne({ _id: normalized }, update);
  return { verified: true, recoveryCodes }; // recoveryCodes is null if this account already had a set
}

// ============================================================
// SMS enrollment — backed by Firebase Phone Auth. The client (FirebasePhoneAuth.js)
// drives the actual send-code/verify-code flow directly against Firebase; by the time
// this is called, phone possession is already proven — enrollSms() just independently
// re-verifies the resulting ID token (never trusts it blind) and records the phone
// number it proves. No separate confirm step, no server-generated OTP.
// ============================================================

export async function enrollSms(email, idToken) {
  const normalized = normalizeEmail(email);
  const { phoneNumber } = await verifyPhoneIdToken(idToken);

  const { memberMfa } = await collections();
  const doc = await memberMfa.findOne({ _id: normalized });
  const update = { $set: { sms: { phoneNumber, verified: true, enrolledAt: new Date().toISOString() } } };
  let recoveryCodes = null;
  if (!doc?.recoveryCodesHashed?.length) {
    const generated = generateRecoveryCodes();
    update.$set.recoveryCodesHashed = generated.hashed;
    recoveryCodes = generated.codes;
  }
  await memberMfa.updateOne({ _id: normalized }, update, { upsert: true });
  return { verified: true, phoneNumber, recoveryCodes };
}

// ============================================================
// Disable — requires proving control of an already-enrolled factor first, never a bare toggle
// ============================================================

export async function disableMfa(email, code) {
  const normalized = normalizeEmail(email);
  const result = await checkFactor(normalized, code);
  if (!result.ok) throw new Error("Incorrect code — MFA was not disabled.");
  const { memberMfa } = await collections();
  await memberMfa.deleteOne({ _id: normalized });
  return { disabled: true };
}

// ============================================================
// Shared factor-checking (TOTP, then a Firebase Phone Auth ID token, then a recovery
// code) — used by both disableMfa() and the login-time verifyMfaPending() below. The
// "code" submitted for a live SMS check is now a Firebase ID token (a JWT), produced by
// the client re-running the FirebasePhoneAuth flow — there's no more server-side OTP to
// generate or resend, so a TOTP digit-string or recovery code just fails token
// verification here and falls through to the other branches untouched.
// ============================================================

async function checkFactor(normalizedEmail, code) {
  const { memberMfa } = await collections();
  const doc = await memberMfa.findOne({ _id: normalizedEmail });
  if (!doc) return { ok: false };
  const trimmed = String(code || "").trim();

  if (doc.totp?.verified) {
    const secretBase32 = decryptSecret(doc.totp.secretEncrypted);
    if (buildTotp(secretBase32, normalizedEmail).validate({ token: trimmed, window: 1 }) !== null) return { ok: true, method: "totp" };
  }
  if (doc.sms?.verified) {
    try {
      const { phoneNumber } = await verifyPhoneIdToken(trimmed, doc.sms.phoneNumber);
      if (phoneNumber) return { ok: true, method: "sms" };
    } catch {
      // Not a valid/matching Firebase ID token — fall through to the other factors.
    }
  }
  if (doc.recoveryCodesHashed?.includes(hashToken(trimmed))) {
    // Recovery codes are single-use — consume it immediately so it can never be replayed.
    await memberMfa.updateOne({ _id: normalizedEmail }, { $pull: { recoveryCodesHashed: hashToken(trimmed) } });
    return { ok: true, method: "recovery" };
  }
  return { ok: false };
}

// ============================================================
// Login-time pending-token flow
// ============================================================

/** Issued by consumeLoginToken()/the Google route INSTEAD OF a real session when the email has
 *  MFA enrolled. Mirrors magic_links' hash+expiry shape exactly. */
export async function issueMfaPendingToken(email) {
  const { mfaPending } = await collections();
  const token = generateToken();
  await mfaPending.insertOne({
    tokenHash: hashToken(token),
    email: normalizeEmail(email),
    attempts: 0,
    expiresAt: new Date(Date.now() + MFA_PENDING_TTL_MS).toISOString(),
    usedAt: null,
    createdAt: new Date().toISOString(),
  });
  return token;
}

/** Verifies a login's second factor. Fails closed and rate-limited: 5 wrong attempts
 *  invalidates the pending token outright (the user must restart login from scratch), not just
 *  "try again forever" — the actual brute-force guard on a 6-digit code's 1-in-1,000,000 space.
 *  Returns { ok: true, email } on success, or { ok: false, error } — never throws, so callers
 *  can return a clean 401/400 without a try/catch. */
export async function verifyMfaPending({ token, code }) {
  const { mfaPending } = await collections();
  const pending = await mfaPending.findOne({ tokenHash: hashToken(token || "") });
  if (!pending || pending.usedAt) return { ok: false, error: "This login attempt is no longer valid — please sign in again." };
  if (new Date(pending.expiresAt).getTime() < Date.now()) return { ok: false, error: "This login attempt expired — please sign in again." };
  if (pending.attempts >= MAX_VERIFY_ATTEMPTS) return { ok: false, error: "Too many incorrect attempts — please sign in again." };

  const result = await checkFactor(pending.email, code);
  if (!result.ok) {
    await mfaPending.updateOne({ _id: pending._id }, { $inc: { attempts: 1 } });
    const remaining = MAX_VERIFY_ATTEMPTS - (pending.attempts + 1);
    return { ok: false, error: remaining > 0 ? `Incorrect code — ${remaining} attempt${remaining === 1 ? "" : "s"} left.` : "Too many incorrect attempts — please sign in again." };
  }

  await mfaPending.updateOne({ _id: pending._id }, { $set: { usedAt: new Date().toISOString() } });
  return { ok: true, email: pending.email };
}
