// src/lib/firebaseAdmin.js
//
// Server-side verification for Firebase Phone Auth ID tokens — the only
// thing this app's server ever sees of the phone-verification flow.
// Firebase's own client SDK (firebaseClient.js) sends and checks the SMS
// code directly with Firebase; this module's job is to independently
// re-verify the resulting signed ID token (never trust it blind) and
// confirm the phone number it actually proves matches what the caller
// claims, before mfa.js records anything as verified.
//
// Needs a real secret: FIREBASE_SERVICE_ACCOUNT_JSON, the full JSON
// content (as one line) of a service-account key downloaded from Firebase
// Console -> Project Settings -> Service Accounts -> Generate new private
// key. Never committed, set only in .env.local / your deployment's env.

// PRODUCTION INCIDENT FIX: firebase-admin's transitive dependency
// jwks-rsa@4.x does a top-level `require()` of the ESM-only `jose`
// package, which crashes with ERR_REQUIRE_ESM in Vercel's serverless
// runtime the instant firebase-admin/app or firebase-admin/auth is
// loaded — even just importing them, before any function here is
// called. This module used to import both statically, so EVERY caller
// of mfa.js (which every login route imports, for the unrelated
// isMfaEnrolled() check) crashed on import, taking down magic-link and
// Google sign-in entirely — not just this module's own phone-MFA
// verification. Both imports are now deferred into getAdminAuth()
// itself, so the crash is scoped to the actual phone-MFA verification
// call path (verifyPhoneIdToken, only reached by enrollSms/checkFactor
// when SMS MFA is actually in use) instead of every login attempt.
// TODO: the underlying jwks-rsa/jose incompatibility should still be
// fixed (upgrade firebase-admin/jwks-rsa or pin an older CJS-compatible
// jose) so phone-MFA verification itself doesn't crash for the smaller
// set of users who have SMS MFA enrolled.
async function getAdminAuth() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not configured — Firebase Phone Auth verification cannot work until it's set.");

  const { initializeApp, getApps, cert } = await import("firebase-admin/app");
  const { getAuth } = await import("firebase-admin/auth");

  if (!getApps().length) {
    let serviceAccount;
    try {
      serviceAccount = JSON.parse(raw);
    } catch {
      throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON.");
    }
    initializeApp({ credential: cert(serviceAccount) });
  }
  return getAuth();
}

/** Verifies a Firebase Phone Auth ID token and confirms it actually proves
 *  control of `expectedPhoneNumber` (E.164) — not just SOME phone number.
 *  Throws on any failure (expired/forged token, wrong phone, misconfigured
 *  service account) rather than returning false, so callers fail closed
 *  by default, same convention as metadata-auth.js's verifyMetadataAuth. */
export async function verifyPhoneIdToken(idToken, expectedPhoneNumber) {
  if (!idToken) throw new Error("No ID token provided.");
  const auth = await getAdminAuth();
  const decoded = await auth.verifyIdToken(idToken);
  if (!decoded.phone_number) throw new Error("This token wasn't issued by a phone sign-in — no phone_number claim present.");
  if (expectedPhoneNumber && decoded.phone_number !== expectedPhoneNumber) {
    throw new Error("The verified phone number doesn't match the one on file for this account.");
  }
  return { phoneNumber: decoded.phone_number, uid: decoded.uid };
}
