// POST /api/analytics/oauth/email-code  { email }        -> a 6-digit sign-in code is emailed (the same answer for unknown emails)
// POST /api/analytics/oauth/email-code  { email, code }  -> signed in (cookie), or { mfaRequired, mfaPendingToken }
// For the Power BI sign-in window, where an emailed link would open in a different browser.
import { NextResponse } from "next/server";
import { SESSION_TTL_MS, SESSION_COOKIE } from "../../../../../lib/orgs.js";
import { sendEmailCode, verifyEmailCode } from "../../../../../lib/analytics/oauth.js";
import { json, handle } from "../../_lib.js";
import { checkRateLimit, getClientIp } from "../../../../../lib/rateLimit.js";

export const dynamic = "force-dynamic";

export async function POST(req) {
  try {
    let b = {}; try { b = await req.json(); } catch { b = {}; }
    try { await checkRateLimit({ action: "pbi-email-code", key: getClientIp(req), max: 20, windowMs: 15 * 60 * 1000 }); }
    catch { return json({ error: "slow_down", error_description: "Too many attempts. Please wait a few minutes." }, 429); }
    if (!b.code) return json(await sendEmailCode(b.email));
    const r = await verifyEmailCode(b.email, b.code);
    if (r.mfaRequired) return json(r);
    const res = NextResponse.json({ authenticated: true, email: r.email }, { headers: { "Cache-Control": "no-store" } });
    res.cookies.set(SESSION_COOKIE, r.sessionToken, { httpOnly: true, secure: process.env.NODE_ENV !== "development", sameSite: "lax", maxAge: SESSION_TTL_MS / 1000, path: "/" });
    return res;
  } catch (err) { return handle(err, "email-code"); }
}
