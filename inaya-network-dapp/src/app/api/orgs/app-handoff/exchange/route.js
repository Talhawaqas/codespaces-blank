// app/api/orgs/app-handoff/exchange/route.js -- POST { code, verifier } from the mobile app -> { authenticated, email, sessionToken }
// (src/lib/appHandoff.js). Rate limited per IP.
import { NextResponse } from "next/server";
import { exchangeHandoff, HandoffError } from "../../../../../lib/appHandoff.js";
import { checkRateLimit, getClientIp } from "../../../../../lib/rateLimit.js";

export const dynamic = "force-dynamic";
const json = (d, s = 200) => NextResponse.json(d, { status: s, headers: { "Cache-Control": "no-store" } });

export async function POST(req) {
  try {
    try { await checkRateLimit({ action: "app-handoff-exchange", key: getClientIp(req), max: 30, windowMs: 10 * 60 * 1000 }); }
    catch { return json({ error: "Too many attempts. Please wait a few minutes." }, 429); }
    let body = {}; try { body = await req.json(); } catch { body = {}; }
    const { email, sessionToken } = await exchangeHandoff({ code: body.code, verifier: body.verifier });
    return json({ authenticated: true, email, sessionToken });
  } catch (err) {
    if (err instanceof HandoffError) return json({ error: err.message }, err.status);
    console.error("orgs/app-handoff/exchange failed:", err?.name); return json({ error: "Could not sign in." }, 500);
  }
}
