// app/api/orgs/login/saml/acs/route.js -- SAML 2.0 Assertion Consumer Service (src/lib/workforceSso.js).
// The identity provider POSTs SAMLResponse + RelayState here. On success: a session cookie on this address and a redirect into
// the workspace on the address the sign-in started from; on failure: back to the sign-in screen with a short reason.
import { NextResponse } from "next/server";
import { createSession, SESSION_TTL_MS, SESSION_COOKIE } from "../../../../../../lib/orgs.js";
import { finishWorkforceSaml, SsoError, appUrl } from "../../../../../../lib/workforceSso.js";

export const dynamic = "force-dynamic";

export async function POST(req) {
  const back = (msg) => NextResponse.redirect(`${appUrl()}/business?ssoError=${encodeURIComponent(msg)}`, 303);
  let form; try { form = await req.formData(); } catch { return back("The sign-in response was not valid."); }
  try {
    const { email, returnTo, base } = await finishWorkforceSaml({ samlResponse: String(form.get("SAMLResponse") || ""), relayState: String(form.get("RelayState") || "") });
    const { sessionToken } = await createSession(email);
    const res = NextResponse.redirect(`${base}${returnTo}`, 303);
    res.cookies.set(SESSION_COOKIE, sessionToken, { httpOnly: true, secure: process.env.NODE_ENV !== "development", sameSite: "lax", maxAge: SESSION_TTL_MS / 1000, path: "/" });
    return res;
  } catch (err) {
    if (err instanceof SsoError) return back(err.message);
    console.error("orgs/login/saml/acs failed:", err?.name); return back("Single sign-on failed. Please try again.");
  }
}
