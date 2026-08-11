// app/api/orgs/login/google/route.js
//
// POST /api/orgs/login/google   { idToken }
//
// Serves both web and mobile from one route, same as consumeLoginToken
// already does for the magic-link flow (web's GET consume route vs
// mobile's POST consume-token route): verifies the Google ID token, issues
// a session, sets the httpOnly cookie web relies on, AND returns the raw
// sessionToken in the JSON body for mobile to store via
// setStoredSessionToken (RN's fetch has no cookie jar, so the Set-Cookie
// header is simply ignored there — harmless, not relied on).
//
// Unlike the magic-link flow, a Google sign-in can legitimately be a
// brand-new email with zero org memberships (magic links only ever reach
// an existing member or an invite) — that's expected and fine here; the
// frontend (business/page.js, OrgHomeScreen.js) handles the
// zero-orgs-after-auth state by offering to create a company.

import { NextResponse } from "next/server";
import { createSession, SESSION_TTL_MS, SESSION_COOKIE } from "../../../../../lib/orgs.js";
import { verifyGoogleIdToken } from "../../../../../lib/googleAuth.js";

export async function POST(req) {
  try {
    const { idToken } = await req.json();
    const { email } = await verifyGoogleIdToken(idToken);
    const { sessionToken } = await createSession(email);

    const response = NextResponse.json({ authenticated: true, email, sessionToken });
    response.cookies.set(SESSION_COOKIE, sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV !== "development",
      sameSite: "lax",
      maxAge: SESSION_TTL_MS / 1000,
      path: "/",
    });
    return response;
  } catch (err) {
    console.error("orgs/login/google failed:", err.message);
    return NextResponse.json({ error: "Could not verify Google sign-in." }, { status: 401 });
  }
}
