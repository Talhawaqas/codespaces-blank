// app/api/admin/session/route.js
//
// GET -> { authed } for the admin layout (src/app/admin/layout.js). When the session is valid the
// cookie is re-issued with a fresh 30-minute lifetime, so an admin who keeps working stays signed in
// and one who stops is signed out 30 minutes after their last activity (founder request, 16 Nov 2026).

import { NextResponse } from "next/server";
import { isAdminAuthenticated, computeAdminSessionCookieValue, ADMIN_SESSION_COOKIE, ADMIN_SESSION_COOKIE_OPTIONS } from "../../../../lib/admin-auth";

export const dynamic = "force-dynamic";

export async function GET(req) {
  if (!isAdminAuthenticated(req)) return NextResponse.json({ authed: false });
  const res = NextResponse.json({ authed: true });
  res.cookies.set(ADMIN_SESSION_COOKIE, computeAdminSessionCookieValue(), ADMIN_SESSION_COOKIE_OPTIONS);
  return res;
}
