// app/api/orgs/logout/route.js
//
// POST /api/orgs/logout
//
// Deletes the session server-side (not just clearing the cookie) so the
// token can't be replayed if it leaked before logout.

import { NextResponse } from "next/server";
import { getOrgCollections, hashToken, SESSION_COOKIE } from "../../../../lib/orgs.js";

export async function POST(req) {
  const rawToken = req.cookies.get(SESSION_COOKIE)?.value;
  if (rawToken) {
    const { sessions } = await getOrgCollections();
    await sessions.deleteOne({ tokenHash: hashToken(rawToken) });
  }
  const response = NextResponse.json({ loggedOut: true });
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
