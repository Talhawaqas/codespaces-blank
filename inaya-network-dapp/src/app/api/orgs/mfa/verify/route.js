// app/api/orgs/mfa/verify/route.js
//
// POST /api/orgs/mfa/verify  Body: { mfaPendingToken, code }
//
// No active session required — this IS the last step of completing
// login, called with the pending token consumeLoginToken()/the Google
// route issued instead of a real session. On success, creates the exact
// same real session every other login path already uses and sets the
// exact same cookie, completing login. On failure, mfa.js's
// verifyMfaPending() already rate-limits (5 attempts) and never throws,
// so this route just relays its { ok, error } result.

import { NextResponse } from "next/server";
import { createSession, SESSION_TTL_MS, SESSION_COOKIE } from "../../../../../lib/orgs.js";
import { verifyMfaPending } from "../../../../../lib/mfa.js";

export async function POST(req) {
  try {
    const { mfaPendingToken, code } = await req.json();
    if (!mfaPendingToken || !code) return NextResponse.json({ error: "mfaPendingToken and code are required." }, { status: 400 });

    const result = await verifyMfaPending({ token: mfaPendingToken, code });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 401 });

    const { sessionToken } = await createSession(result.email);
    // sessionToken in the JSON body too, not just the cookie -- mobile has
    // no cookie jar and stores this directly (see inaya-mobile's orgApi.js
    // header comment), same reason google/route.js and consume-token both
    // already return it alongside setting the cookie for web.
    const response = NextResponse.json({ authenticated: true, email: result.email, sessionToken });
    response.cookies.set(SESSION_COOKIE, sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV !== "development",
      sameSite: "lax",
      maxAge: SESSION_TTL_MS / 1000,
      path: "/",
    });
    return response;
  } catch (err) {
    console.error("orgs/mfa/verify POST failed:", err);
    return NextResponse.json({ error: "Could not verify — please try again." }, { status: 500 });
  }
}
