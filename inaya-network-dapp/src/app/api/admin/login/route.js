// app/api/admin/login/route.js
//
// POST /api/admin/login
// Body: { passphrase }
//
// The only route that ever sees the raw passphrase — verifies it
// server-side against ADMIN_DASHBOARD_PASSPHRASE, and if it matches,
// sets the HttpOnly session cookie every other /api/admin/* route
// requires. Deliberately generic error message on failure (doesn't
// distinguish "wrong passphrase" from "not configured") so a probing
// request can't learn server configuration state.

import { NextResponse } from "next/server";
import { verifyAdminPassphrase, computeAdminSessionCookieValue, ADMIN_SESSION_COOKIE, ADMIN_SESSION_COOKIE_OPTIONS } from "../../../../lib/admin-auth";
import { checkRateLimit, getClientIp } from "../../../../lib/rateLimit.js";

export async function POST(req) {
  try {
    // This one shared passphrase gates every /admin/* surface (all orgs' aggregated data) --
    // verifyAdminPassphrase()'s own timing-safe comparison stops a timing side-channel, but
    // nothing previously stopped an attacker from just submitting guesses as fast as the network
    // allows. 10 attempts per IP per 15 minutes is generous for a real admin fat-fingering a
    // passphrase, and makes online brute force against any reasonably-sized passphrase infeasible.
    try {
      await checkRateLimit({ action: "admin-login", key: getClientIp(req), max: 10, windowMs: 15 * 60 * 1000 });
    } catch {
      return NextResponse.json({ error: "Too many attempts — please wait a while and try again." }, { status: 429 });
    }

    const { passphrase } = await req.json();
    const ok = verifyAdminPassphrase(passphrase);
    if (!ok) {
      return NextResponse.json({ error: "Invalid passphrase." }, { status: 401 });
    }

    const res = NextResponse.json({ ok: true });
    res.cookies.set(ADMIN_SESSION_COOKIE, computeAdminSessionCookieValue(), ADMIN_SESSION_COOKIE_OPTIONS);
    return res;
  } catch (err) {
    console.error("admin/login failed:", err);
    return NextResponse.json({ error: "Invalid passphrase." }, { status: 401 });
  }
}
