// app/api/moderator/login/route.js
//
// POST /api/moderator/login
// Body: { passphrase }
//
// Separate from /api/admin/login — verifies against
// MODERATOR_DASHBOARD_PASSPHRASE, a different secret than the admin
// passphrase, so this credential can be handed to moderators without also
// granting full admin access.

import { NextResponse } from "next/server";
import { verifyModeratorPassphrase, computeModeratorSessionCookieValue, MODERATOR_SESSION_COOKIE, MODERATOR_SESSION_COOKIE_OPTIONS } from "../../../../lib/moderator-auth.js";
import { checkRateLimit, getClientIp } from "../../../../lib/rateLimit.js";

export async function POST(req) {
  try {
    try {
      await checkRateLimit({ action: "moderator-login", key: getClientIp(req), max: 10, windowMs: 15 * 60 * 1000 });
    } catch {
      return NextResponse.json({ error: "Too many attempts — please wait a while and try again." }, { status: 429 });
    }

    const { passphrase } = await req.json();
    const ok = verifyModeratorPassphrase(passphrase);
    if (!ok) {
      return NextResponse.json({ error: "Invalid passphrase." }, { status: 401 });
    }

    const res = NextResponse.json({ ok: true });
    res.cookies.set(MODERATOR_SESSION_COOKIE, computeModeratorSessionCookieValue(), MODERATOR_SESSION_COOKIE_OPTIONS);
    return res;
  } catch (err) {
    console.error("moderator/login failed:", err);
    return NextResponse.json({ error: "Invalid passphrase." }, { status: 401 });
  }
}
