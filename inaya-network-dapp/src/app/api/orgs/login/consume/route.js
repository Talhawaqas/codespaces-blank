// app/api/orgs/login/consume/route.js
//
// GET /api/orgs/login/consume?token=...
//
// This is the URL the magic link itself points to — meant to be opened
// directly (pasted into a browser, or eventually clicked from an email),
// not called via fetch, so it validates the token, sets the session
// cookie, and redirects into the app rather than returning JSON.
//
// If the token's purpose is "invite", consuming it also flips that
// org_member's status from "invited" to "active" — accepting an invite
// and logging in are the same action from the token's perspective.

import { NextResponse } from "next/server";
import { consumeLoginToken, SESSION_TTL_MS, SESSION_COOKIE } from "../../../../../lib/orgs.js";
import { isMfaEnrolled, issueMfaPendingToken } from "../../../../../lib/mfa.js";

export async function GET(req) {
  const { searchParams, origin } = new URL(req.url);
  const token = searchParams.get("token");

  const result = await consumeLoginToken(token);
  if (result.error) {
    return NextResponse.redirect(`${origin}/business?orgLoginError=${result.error}`);
  }

  // MFA gate — additive: a member who never enrolled hits neither of these
  // checks and falls straight through to the exact same session-creation
  // this route always did.
  if (await isMfaEnrolled(result.email)) {
    const mfaPendingToken = await issueMfaPendingToken(result.email);
    return NextResponse.redirect(`${origin}/business?mfaPending=${mfaPendingToken}`);
  }

  const response = NextResponse.redirect(`${origin}/business?orgLoggedIn=true`);
  response.cookies.set(SESSION_COOKIE, result.sessionToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV !== "development",
    sameSite: "lax",
    maxAge: SESSION_TTL_MS / 1000,
    path: "/",
  });
  return response;
}
