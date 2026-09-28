// app/api/moderator/logout/route.js — clears the moderator session cookie.

import { NextResponse } from "next/server";
import { MODERATOR_SESSION_COOKIE } from "../../../../lib/moderator-auth.js";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(MODERATOR_SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
