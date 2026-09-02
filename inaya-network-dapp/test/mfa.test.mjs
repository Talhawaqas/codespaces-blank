// test/mfa.test.mjs
//
// MFA (Business Workspace) coverage: mfaCrypto's encrypt/decrypt round
// trip + tamper detection, the full TOTP enroll->confirm->login-verify
// flow using real otpauth-generated codes (not mocked), the Firebase
// Phone Auth SMS flow (enroll/login-verify/disable) against a stubbed
// verifyPhoneIdToken (a real Firebase ID token can't be generated
// without a live Firebase project — see firebaseAdmin.js), recovery-code
// single-use, and the 5-attempt brute-force lockout on the login-time
// pending token. Same node --test + real Atlas + RUN_ID-fixtures
// convention as every other test file here.
//
// mfa.js imports verifyPhoneIdToken from firebaseAdmin.js statically, so
// stubbing it requires mock.module() to run BEFORE mfa.js is first
// loaded — that's why mfa.js's exports are pulled in via a top-level
// dynamic import below instead of a static "import ... from" like every
// other module here. --experimental-test-module-mocks is required (see
// package.json's "test" script) for mock.module() to exist at all.
//
// Run with: node --env-file=.env.local --experimental-test-module-mocks --test test/mfa.test.mjs

import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { TOTP, Secret } from "otpauth";
import { encryptSecret, decryptSecret } from "../src/lib/mfaCrypto.js";
import { connectToDatabase } from "../src/lib/mongodb.js";
import mongoClientPromise from "../src/lib/mongodb.js";

/** Stands in for firebaseAdmin.js's real verifyPhoneIdToken(), which needs a live Firebase
 *  project to produce a real signed ID token. Fake tokens here are just JSON strings carrying
 *  the phone number they "prove" — opaque to mfa.js either way, which only ever treats the
 *  token as a string to hand off for verification. Mirrors the real function's fail-closed
 *  contract: throws (never returns falsy) on a missing/mismatched phone number. */
async function fakeVerifyPhoneIdToken(idToken, expectedPhoneNumber) {
  if (!idToken) throw new Error("No ID token provided.");
  let decoded;
  try {
    decoded = JSON.parse(idToken);
  } catch {
    throw new Error("Invalid fake ID token.");
  }
  if (!decoded.phoneNumber) throw new Error("This token wasn't issued by a phone sign-in — no phone_number claim present.");
  if (expectedPhoneNumber && decoded.phoneNumber !== expectedPhoneNumber) {
    throw new Error("The verified phone number doesn't match the one on file for this account.");
  }
  return { phoneNumber: decoded.phoneNumber, uid: decoded.uid || `fake-${decoded.phoneNumber}` };
}

function fakeIdToken(phoneNumber) {
  return JSON.stringify({ phoneNumber, uid: `fake-${phoneNumber}` });
}

mock.module("../src/lib/firebaseAdmin.js", { exports: { verifyPhoneIdToken: fakeVerifyPhoneIdToken } });

const {
  enrollTotp, confirmTotp, enrollSms, getMfaStatus, isMfaEnrolled,
  issueMfaPendingToken, verifyMfaPending, disableMfa,
} = await import("../src/lib/mfa.js");

const RUN_ID = randomUUID().slice(0, 8);
const email = (label) => `test-mfa-${RUN_ID}-${label}@example.com`;

const cleanup = { emails: [] };
function tracked(label) {
  const e = email(label);
  cleanup.emails.push(e);
  return e;
}

after(async () => {
  const { db } = await connectToDatabase();
  await db.collection("member_mfa").deleteMany({ _id: { $in: cleanup.emails } });
  await db.collection("mfa_pending").deleteMany({ email: { $in: cleanup.emails } });
  const client = await mongoClientPromise;
  await client.close();
});

/** Computes the real current TOTP code for a base32 secret — same algorithm mfa.js's own
 *  buildTotp() uses, so this simulates a real authenticator app rather than mocking anything. */
function currentCodeFor(secretBase32, forEmail) {
  return new TOTP({ issuer: "Inaya Network", label: forEmail, algorithm: "SHA1", digits: 6, period: 30, secret: Secret.fromBase32(secretBase32) }).generate();
}

test("mfaCrypto: encrypt/decrypt round-trips exactly, a tampered ciphertext fails closed", () => {
  const secret = "JBSWY3DPEHPK3PXP";
  const encrypted = encryptSecret(secret);
  assert.equal(decryptSecret(encrypted), secret);

  const tampered = Buffer.from(encrypted, "base64");
  tampered[tampered.length - 1] ^= 0xff; // flip the last ciphertext byte
  assert.throws(() => decryptSecret(tampered.toString("base64")));
});

test("isMfaEnrolled: false before any enrollment", async () => {
  const e = tracked("unenrolled");
  assert.equal(await isMfaEnrolled(e), false);
});

test("TOTP: full enroll -> confirm -> login-verify flow with a real otpauth-generated code", async () => {
  const e = tracked("totp-flow");

  const enrollment = await enrollTotp(e);
  assert.ok(enrollment.secret);
  assert.match(enrollment.uri, /^otpauth:\/\/totp\//);
  assert.match(enrollment.qrDataUri, /^data:image\/png;base64,/);

  // Wrong code rejected before confirming
  await assert.rejects(() => confirmTotp(e, "000000"), /doesn't match/);

  const realCode = currentCodeFor(enrollment.secret, e.toLowerCase());
  const confirmed = await confirmTotp(e, realCode);
  assert.equal(confirmed.verified, true);
  assert.equal(confirmed.recoveryCodes.length, 10);

  assert.equal(await isMfaEnrolled(e), true);
  const status = await getMfaStatus(e);
  assert.equal(status.totpEnabled, true);
  assert.equal(status.hasRecoveryCodes, true);

  // Login-time flow: issue a pending token (what consumeLoginToken()/google route do instead of
  // createSession() once MFA is enrolled), then verify it with a fresh real code.
  const pendingToken = await issueMfaPendingToken(e);
  const loginCode = currentCodeFor(enrollment.secret, e.toLowerCase());
  const result = await verifyMfaPending({ token: pendingToken, code: loginCode });
  assert.equal(result.ok, true);
  assert.equal(result.email, e.toLowerCase());
});

test("verifyMfaPending: a wrong code is rejected and does not consume the pending token", async () => {
  const e = tracked("wrong-code");
  const enrollment = await enrollTotp(e);
  await confirmTotp(e, currentCodeFor(enrollment.secret, e.toLowerCase()));

  const pendingToken = await issueMfaPendingToken(e);
  const wrong = await verifyMfaPending({ token: pendingToken, code: "111111" });
  assert.equal(wrong.ok, false);
  assert.match(wrong.error, /Incorrect code/);

  // The token is still usable for a correct attempt right after.
  const right = await verifyMfaPending({ token: pendingToken, code: currentCodeFor(enrollment.secret, e.toLowerCase()) });
  assert.equal(right.ok, true);
});

test("verifyMfaPending: 5 wrong attempts invalidates the pending token outright", async () => {
  const e = tracked("lockout");
  const enrollment = await enrollTotp(e);
  await confirmTotp(e, currentCodeFor(enrollment.secret, e.toLowerCase()));
  const pendingToken = await issueMfaPendingToken(e);

  for (let i = 0; i < 5; i++) {
    const attempt = await verifyMfaPending({ token: pendingToken, code: "000000" });
    assert.equal(attempt.ok, false);
  }
  // Even the REAL code is now rejected — the token itself is dead, not just "wrong code".
  const finalAttempt = await verifyMfaPending({ token: pendingToken, code: currentCodeFor(enrollment.secret, e.toLowerCase()) });
  assert.equal(finalAttempt.ok, false);
  assert.match(finalAttempt.error, /Too many incorrect attempts|no longer valid/);
});

test("verifyMfaPending: a nonexistent/expired token is rejected cleanly", async () => {
  const result = await verifyMfaPending({ token: "not-a-real-token", code: "123456" });
  assert.equal(result.ok, false);
});

test("recovery codes: work exactly once, rejected on reuse", async () => {
  const e = tracked("recovery");
  const enrollment = await enrollTotp(e);
  const confirmed = await confirmTotp(e, currentCodeFor(enrollment.secret, e.toLowerCase()));
  const recoveryCode = confirmed.recoveryCodes[0];

  const pendingToken1 = await issueMfaPendingToken(e);
  const first = await verifyMfaPending({ token: pendingToken1, code: recoveryCode });
  assert.equal(first.ok, true);

  const pendingToken2 = await issueMfaPendingToken(e);
  const second = await verifyMfaPending({ token: pendingToken2, code: recoveryCode });
  assert.equal(second.ok, false, "a recovery code must not be usable twice");
});

test("confirmTotp: a second method confirmed later does NOT regenerate recovery codes", async () => {
  // Simulates enrolling TOTP twice in a row (re-running enrollTotp overwrites the pending
  // secret, same as a user retrying) -- recoveryCodes should only ever be issued once per account.
  const e = tracked("no-regenerate");
  const enrollment1 = await enrollTotp(e);
  const first = await confirmTotp(e, currentCodeFor(enrollment1.secret, e.toLowerCase()));
  assert.ok(first.recoveryCodes);

  const enrollment2 = await enrollTotp(e); // re-enroll (e.g. lost the device, setting up again)
  const second = await confirmTotp(e, currentCodeFor(enrollment2.secret, e.toLowerCase()));
  assert.equal(second.recoveryCodes, null, "recovery codes already exist for this account");
});

test("disableMfa: requires a valid code, removes enrollment entirely on success", async () => {
  const e = tracked("disable");
  const enrollment = await enrollTotp(e);
  await confirmTotp(e, currentCodeFor(enrollment.secret, e.toLowerCase()));
  assert.equal(await isMfaEnrolled(e), true);

  await assert.rejects(() => disableMfa(e, "000000"), /Incorrect code/);
  assert.equal(await isMfaEnrolled(e), true, "a wrong code must not disable MFA");

  await disableMfa(e, currentCodeFor(enrollment.secret, e.toLowerCase()));
  assert.equal(await isMfaEnrolled(e), false);
});

// ============================================================
// SMS (Firebase Phone Auth) — verifyPhoneIdToken is stubbed above; everything else
// (member_mfa storage, checkFactor's branch order, recovery-code issuance-once) is real.
// ============================================================

test("enrollSms: verifies the Firebase ID token and records the phone, issues recovery codes once", async () => {
  const e = tracked("sms-enroll");
  const result = await enrollSms(e, fakeIdToken("+15559990001"));
  assert.equal(result.verified, true);
  assert.equal(result.phoneNumber, "+15559990001");
  assert.equal(result.recoveryCodes.length, 10);

  const status = await getMfaStatus(e);
  assert.equal(status.smsEnabled, true);
  assert.equal(status.smsPhoneLast4, "0001");
  assert.equal(await isMfaEnrolled(e), true);
});

test("enrollSms: a token with no phone_number claim is rejected", async () => {
  const e = tracked("sms-enroll-bad");
  await assert.rejects(() => enrollSms(e, JSON.stringify({})), /no phone_number claim/);
  assert.equal(await isMfaEnrolled(e), false);
});

test("SMS login-verify: a fresh Firebase ID token for the enrolled phone number succeeds", async () => {
  const e = tracked("sms-login");
  await enrollSms(e, fakeIdToken("+15559990002"));

  const pendingToken = await issueMfaPendingToken(e);
  const result = await verifyMfaPending({ token: pendingToken, code: fakeIdToken("+15559990002") });
  assert.equal(result.ok, true);
  assert.equal(result.email, e.toLowerCase());
});

test("SMS login-verify: an ID token proving a DIFFERENT phone number is rejected", async () => {
  const e = tracked("sms-wrong-phone");
  await enrollSms(e, fakeIdToken("+15559990003"));

  const pendingToken = await issueMfaPendingToken(e);
  const result = await verifyMfaPending({ token: pendingToken, code: fakeIdToken("+15559990099") });
  assert.equal(result.ok, false);
});

test("disableMfa: a valid Firebase ID token proves control and disables SMS enrollment", async () => {
  const e = tracked("sms-disable");
  await enrollSms(e, fakeIdToken("+15559990004"));
  assert.equal(await isMfaEnrolled(e), true);

  await assert.rejects(() => disableMfa(e, fakeIdToken("+15550000000")), /Incorrect code/);
  assert.equal(await isMfaEnrolled(e), true, "an ID token for the wrong phone must not disable MFA");

  await disableMfa(e, fakeIdToken("+15559990004"));
  assert.equal(await isMfaEnrolled(e), false);
});
