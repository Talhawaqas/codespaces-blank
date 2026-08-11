// src/lib/googleAuth.js
//
// Server-side verification of a Google "Sign in with Google" ID token —
// used by POST /api/orgs/login/google. Deliberately just the small,
// official verification library (google-auth-library), not a full auth
// framework like NextAuth — matches this codebase's existing lightweight,
// hand-rolled auth style in orgs.js.
//
// V1 uses a single Google OAuth "Web application" client ID for both web
// (Google Identity Services JS SDK) and mobile (expo-auth-session's Google
// provider, via Expo's auth proxy, which presents as the same Web client).
// GOOGLE_ALLOWED_CLIENT_IDS is an array so a dedicated iOS/Android client
// can be added later purely as config — no server code change needed.

import { OAuth2Client } from "google-auth-library";
import { normalizeEmail } from "./orgs.js";

const GOOGLE_ALLOWED_CLIENT_IDS = [process.env.GOOGLE_CLIENT_ID].filter(Boolean);

const client = new OAuth2Client();

/** Verifies a Google ID token's signature and audience, and requires the
 *  email to be Google-verified. Returns { email } or throws. */
export async function verifyGoogleIdToken(idToken) {
  if (!idToken) throw new Error("Missing Google ID token.");
  if (GOOGLE_ALLOWED_CLIENT_IDS.length === 0) {
    throw new Error("Google sign-in isn't configured (GOOGLE_CLIENT_ID missing).");
  }

  const ticket = await client.verifyIdToken({
    idToken,
    audience: GOOGLE_ALLOWED_CLIENT_IDS,
  });
  const payload = ticket.getPayload();

  if (!payload?.email) throw new Error("Google account has no email.");
  if (!payload.email_verified) throw new Error("Google account email isn't verified.");

  return { email: normalizeEmail(payload.email) };
}
