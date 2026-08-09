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
import { getOrgCollections, ensureOrgIndexes, hashToken, generateToken, SESSION_TTL_MS, SESSION_COOKIE } from "../../../../../lib/orgs.js";

export async function GET(req) {
  const { searchParams, origin } = new URL(req.url);
  const token = searchParams.get("token");
  if (!token) {
    return NextResponse.redirect(`${origin}/business?orgLoginError=missing_token`);
  }

  await ensureOrgIndexes();
  const { magicLinks, orgMembers, sessions } = await getOrgCollections();

  const link = await magicLinks.findOne({ tokenHash: hashToken(token) });
  if (!link || link.usedAt || new Date(link.expiresAt).getTime() < Date.now()) {
    return NextResponse.redirect(`${origin}/business?orgLoginError=invalid_or_expired`);
  }

  const now = new Date().toISOString();
  await magicLinks.updateOne({ _id: link._id }, { $set: { usedAt: now } });

  if (link.purpose === "invite" && link.orgId) {
    await orgMembers.updateOne(
      { orgId: link.orgId, email: link.email },
      { $set: { status: "active", joinedAt: now } }
    );
  }

  const sessionToken = generateToken();
  await sessions.insertOne({
    tokenHash: hashToken(sessionToken),
    email: link.email,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    createdAt: now,
  });

  const response = NextResponse.redirect(`${origin}/business?orgLoggedIn=true`);
  response.cookies.set(SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV !== "development",
    sameSite: "lax",
    maxAge: SESSION_TTL_MS / 1000,
    path: "/",
  });
  return response;
}
