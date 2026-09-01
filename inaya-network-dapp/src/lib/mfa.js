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
import { getSmsProvider, isSmsConfigured } from "./smsProviders/index.js";
import { encryptSecret, decryptSecret } from "./mfaCrypto.js";

const ISSUER = "Inaya Network";
const MFA_PENDING_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_VERIFY_ATTEMPTS = 5;
const SMS_OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
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
// SMS enrollment
// ============================================================

export async function enrollSms(email, phoneNumber) {
  if (!isSmsConfigured()) throw new Error("SMS delivery isn't configured yet — set TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_FROM_NUMBER to enable it.");
  const normalized = normalizeEmail(email);
  const cleanPhone = String(phoneNumber || "").trim();
  if (!/^\+[1-9]\d{6,14}$/.test(cleanPhone)) throw new Error("Phone number must be in E.164 format, e.g. +15551234567.");

  const otp = String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
  const { memberMfa } = await collections();
  await memberMfa.updateOne(
    { _id: normalized },
    { $set: { sms: { phoneNumber: cleanPhone, verified: false, otpHash: hashToken(otp), otpExpiresAt: new Date(Date.now() + SMS_OTP_TTL_MS).toISOString(), enrolledAt: new Date().toISOString() } } },
    { upsert: true }
  );

  await getSmsProvider().sendSms(cleanPhone, `Your Inaya Network verification code is ${otp}. It expires in 10 minutes.`);
  return { sent: true, phoneNumber: cleanPhone };
}

export async function confirmSms(email, code) {
  const normalized = normalizeEmail(email);
  const { memberMfa } = await collections();
  const doc = await memberMfa.findOne({ _id: normalized });
  if (!doc?.sms || doc.sms.verified) throw new Error("No pending SMS enrollment for this account — call enrollSms() first.");
  if (new Date(doc.sms.otpExpiresAt).getTime() < Date.now()) throw new Error("That code has expired — request a new one.");
  if (hashToken(String(code || "").trim()) !== doc.sms.otpHash) throw new Error("That code doesn't match — check your messages and try again.");

  const update = { $set: { "sms.verified": true }, $unset: { "sms.otpHash": "", "sms.otpExpiresAt": "" } };
  let recoveryCodes = null;
  if (!doc.recoveryCodesHashed?.length) {
    const generated = generateRecoveryCodes();
    update.$set.recoveryCodesHashed = generated.hashed;
    recoveryCodes = generated.codes;
  }
  await memberMfa.updateOne({ _id: normalized }, update);
  return { verified: true, recoveryCodes };
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
// Shared factor-checking (TOTP, then SMS live OTP, then a recovery code) — used by both
// disableMfa() and the login-time verifyMfaPending() below.
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
  if (doc.sms?.verified && doc.sms.otpHash && new Date(doc.sms.otpExpiresAt).getTime() >= Date.now() && hashToken(trimmed) === doc.sms.otpHash) {
    return { ok: true, method: "sms" };
  }
  if (doc.recoveryCodesHashed?.includes(hashToken(trimmed))) {
    // Recovery codes are single-use — consume it immediately so it can never be replayed.
    await memberMfa.updateOne({ _id: normalizedEmail }, { $pull: { recoveryCodesHashed: hashToken(trimmed) } });
    return { ok: true, method: "recovery" };
  }
  return { ok: false };
}

/** For a login's SMS step — sends a fresh live OTP the same way enrollSms() does, without
 *  touching the already-verified phone/verified flag. */
export async function sendLoginSmsCode(email) {
  const normalized = normalizeEmail(email);
  const { memberMfa } = await collections();
  const doc = await memberMfa.findOne({ _id: normalized });
  if (!doc?.sms?.verified) throw new Error("SMS is not enrolled for this account.");

  const otp = String(Math.floor(100000 + Math.random() * 900000));
  await memberMfa.updateOne({ _id: normalized }, { $set: { "sms.otpHash": hashToken(otp), "sms.otpExpiresAt": new Date(Date.now() + SMS_OTP_TTL_MS).toISOString() } });
  await getSmsProvider().sendSms(doc.sms.phoneNumber, `Your Inaya Network sign-in code is ${otp}. It expires in 10 minutes.`);
  return { sent: true };
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

/** For the login-time verify screen's "resend SMS code" action — takes the mfaPendingToken
 *  (never a client-supplied email) so a live OTP can only ever be sent for the account that
 *  actually just completed primary auth, looked up server-side. */
export async function sendLoginSmsForPendingToken(token) {
  const { mfaPending } = await collections();
  const pending = await mfaPending.findOne({ tokenHash: hashToken(token || "") });
  if (!pending || pending.usedAt || new Date(pending.expiresAt).getTime() < Date.now()) {
    throw new Error("This login attempt is no longer valid — please sign in again.");
  }
  return sendLoginSmsCode(pending.email);
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
