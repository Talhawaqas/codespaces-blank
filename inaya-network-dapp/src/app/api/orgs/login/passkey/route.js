// app/api/orgs/login/passkey/route.js -- sign in with a passkey (src/lib/passkeys.js).
//   POST { step: "start" }                            -> { options, requestToken }
//   POST { step: "finish", requestToken, response }   -> { authenticated, email, sessionToken } + the session cookie
// A passkey with user verification is already two factors, so it completes sign-in without the authenticator-app/SMS step.
import { NextResponse } from "next/server";
import { createSession, SESSION_TTL_MS, SESSION_COOKIE } from "../../../../../lib/orgs.js";
import { startLogin, finishLogin, PasskeyError } from "../../../../../lib/passkeys.js";

export const dynamic = "force-dynamic";
const json = (d, s = 200) => NextResponse.json(d, { status: s, headers: { "Cache-Control": "no-store" } });

export async function POST(req) {
  try {
    let body = {}; try { body = await req.json(); } catch { body = {}; }
    if (body.step === "start") return json(await startLogin({ origin: req.headers.get("origin") }));
    if (body.step !== "finish") return json({ error: "step must be start or finish." }, 400);
    const { email } = await finishLogin({ requestToken: body.requestToken, response: body.response });
    const { sessionToken } = await createSession(email);
    const res = json({ authenticated: true, email, sessionToken });
    res.cookies.set(SESSION_COOKIE, sessionToken, { httpOnly: true, secure: process.env.NODE_ENV !== "development", sameSite: "lax", maxAge: SESSION_TTL_MS / 1000, path: "/" });
    return res;
  } catch (err) {
    if (err instanceof PasskeyError) return json({ error: err.message }, err.status);
    console.error("orgs/login/passkey failed:", err?.name); return json({ error: "Could not sign in with the passkey." }, 500);
  }
}
