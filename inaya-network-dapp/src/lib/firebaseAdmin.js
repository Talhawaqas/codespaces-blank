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

import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

function getAdminAuth() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not configured — Firebase Phone Auth verification cannot work until it's set.");

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
  const auth = getAdminAuth();
  const decoded = await auth.verifyIdToken(idToken);
  if (!decoded.phone_number) throw new Error("This token wasn't issued by a phone sign-in — no phone_number claim present.");
  if (expectedPhoneNumber && decoded.phone_number !== expectedPhoneNumber) {
    throw new Error("The verified phone number doesn't match the one on file for this account.");
  }
  return { phoneNumber: decoded.phone_number, uid: decoded.uid };
}
