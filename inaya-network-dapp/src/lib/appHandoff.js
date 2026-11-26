// src/lib/appHandoff.js
//
// Signing the mobile app in through the website, for sign-in methods the app cannot do natively yet (passkeys, company SSO).
// The app opens a secure in-app browser tab (Chrome Custom Tab / ASWebAuthenticationSession) at /business/app-signin with a
// PKCE-style challenge; the person signs in there (passkey or SSO, on www.inayanetwork.com, so their existing passkey works);
// the page asks for a one-time code and sends the browser to the app's own scheme with it; the app redeems the code with the
// matching verifier and receives an ordinary session token.
//
//   * the code is random, stored hashed in `mfa_pending` (purpose "app-handoff"), single use, valid 2 minutes;
//   * redeeming needs the verifier whose SHA-256 is the challenge the app chose, so another app that intercepts the code
//     (a hostile app registered for the same scheme) cannot use it;
//   * the code is bound to the person who was signed in when it was made; it creates a new session, it never moves one;
//   * a code is only made right after a fresh sign-in (a session younger than FRESH_MS) and after the person presses
//     "Continue to the app", so an app that opens this page on its own cannot silently collect a code for someone who
//     happens to be signed in on the website already.

import { createHash } from "node:crypto";
import { connectToDatabase } from "./mongodb.js";
import { hashToken, generateToken, createSession } from "./orgs.js";

const TTL_MS = 2 * 60 * 1000;
export const FRESH_MS = 10 * 60 * 1000;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/; // base64url SHA-256
export const APP_REDIRECTS = ["inayamobile://auth"];

export class HandoffError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new HandoffError(status, message); };
async function col() { const { db } = await connectToDatabase(); return db.collection("mfa_pending"); }

/** Pure: is this a redirect the website may send a handoff code to? */
export const isAppRedirect = (r) => APP_REDIRECTS.includes(String(r || ""));
/** Pure: the challenge for a verifier (base64url SHA-256). */
export const challengeFor = (verifier) => createHash("sha256").update(String(verifier)).digest("base64url");

/** Signed in on the website: make a one-time code for the app. */
export async function createHandoff({ email, challenge, sessionCreatedAt = null, now = Date.now() }) {
  if (!email) fail(401, "Not signed in.");
  if (!sessionCreatedAt || now - new Date(sessionCreatedAt).getTime() > FRESH_MS) fail(401, "Please sign in again on this page to continue to the app.");
  if (!CHALLENGE.test(String(challenge || ""))) fail(400, "The app's sign-in request was not valid. Close this page and try again from the app.");
  const code = generateToken();
  await (await col()).insertOne({ tokenHash: hashToken(code), purpose: "app-handoff", email, challenge, usedAt: null, attempts: 0, expiresAt: new Date(Date.now() + TTL_MS).toISOString(), createdAt: new Date().toISOString() });
  return { code };
}

/** In the app: redeem the code with the verifier. Returns { email, sessionToken }. */
export async function exchangeHandoff({ code, verifier }) {
  if (typeof code !== "string" || typeof verifier !== "string" || code.length > 200 || verifier.length < 43 || verifier.length > 128) fail(400, "The sign-in code was not valid.");
  const row = await (await col()).findOneAndUpdate({ tokenHash: hashToken(code), purpose: "app-handoff", usedAt: null }, { $set: { usedAt: new Date().toISOString() } });
  if (!row || new Date(row.expiresAt).getTime() < Date.now()) fail(400, "This sign-in expired or was already used. Please sign in again.");
  if (challengeFor(verifier) !== row.challenge) fail(400, "This sign-in code belongs to a different request.");
  const { sessionToken } = await createSession(row.email);
  return { email: row.email, sessionToken };
}
