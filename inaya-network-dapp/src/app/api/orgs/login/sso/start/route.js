// app/api/orgs/login/sso/start/route.js -- POST { email } -> { url } of the company's identity provider (src/lib/workforceSso.js).
// Also GET ?email= -> { sso: true|false } so the sign-in screen can offer the button. Neither reveals the company's name.
import { NextResponse } from "next/server";
import { startWorkforceSso, ssoOrgForEmail, SsoError } from "../../../../../../lib/workforceSso.js";
import { checkRateLimit, getClientIp } from "../../../../../../lib/rateLimit.js";

export const dynamic = "force-dynamic";
const json = (d, s = 200) => NextResponse.json(d, { status: s, headers: { "Cache-Control": "no-store" } });

export async function GET(req) {
  try { return json({ sso: !!(await ssoOrgForEmail(new URL(req.url).searchParams.get("email") || "")) }); }
  catch { return json({ sso: false }); }
}
export async function POST(req) {
  try {
    try { await checkRateLimit({ action: "workforce-sso-start", key: getClientIp(req), max: 20, windowMs: 10 * 60 * 1000 }); }
    catch { return json({ error: "Too many attempts. Please wait a few minutes." }, 429); }
    let body = {}; try { body = await req.json(); } catch { body = {}; }
    return json(await startWorkforceSso({ email: body.email, returnTo: body.returnTo }));
  } catch (err) {
    if (err instanceof SsoError) return json({ error: err.message }, err.status);
    console.error("orgs/login/sso/start failed:", err?.name); return json({ error: "Could not start single sign-on." }, 500);
  }
}
