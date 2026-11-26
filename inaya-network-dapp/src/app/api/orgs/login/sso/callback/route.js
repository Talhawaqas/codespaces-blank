// app/api/orgs/login/sso/callback/route.js -- the identity provider sends the browser back here (src/lib/workforceSso.js).
// On success: a session cookie and a redirect into the workspace. On failure: back to the sign-in screen with a short reason.
import { NextResponse } from "next/server";
import { createSession, SESSION_TTL_MS, SESSION_COOKIE } from "../../../../../../lib/orgs.js";
import { finishWorkforceSso, SsoError, appUrl } from "../../../../../../lib/workforceSso.js";

export const dynamic = "force-dynamic";

export async function GET(req) {
  const q = new URL(req.url).searchParams;
  const back = (msg) => NextResponse.redirect(`${appUrl()}/business?ssoError=${encodeURIComponent(msg)}`);
  if (q.get("error")) return back(String(q.get("error_description") || "Your identity provider cancelled the sign-in.").slice(0, 200));
  try {
    const { email, returnTo } = await finishWorkforceSso({ code: q.get("code"), state: q.get("state") });
    const { sessionToken } = await createSession(email);
    const res = NextResponse.redirect(`${appUrl()}${returnTo}`);
    res.cookies.set(SESSION_COOKIE, sessionToken, { httpOnly: true, secure: process.env.NODE_ENV !== "development", sameSite: "lax", maxAge: SESSION_TTL_MS / 1000, path: "/" });
    return res;
  } catch (err) {
    if (err instanceof SsoError) return back(err.message);
    console.error("orgs/login/sso/callback failed:", err?.name); return back("Single sign-on failed. Please try again.");
  }
}
