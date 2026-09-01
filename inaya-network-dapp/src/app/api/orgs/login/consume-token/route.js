// app/api/orgs/login/consume-token/route.js
//
// POST /api/orgs/login/consume-token
// Body: { token }
//
// Mobile counterpart to GET /api/orgs/login/consume. That route is built for
// a browser to navigate to directly (it redirects and sets an HttpOnly
// cookie) — but a magic link opened from an email on a phone opens the
// device's system browser, not the app, so any cookie it receives stays
// trapped there and never reaches the app's own fetch calls. Since there's
// no App Links/Universal Links setup in this codebase to make the link open
// the app directly, the mobile flow instead has the user copy the emailed
// link (or just the token) into the app, which calls this route itself and
// gets the raw session token back in the JSON body. The app stores it and
// sends it back as `Authorization: Bearer <token>` on every subsequent
// request — see getRawSessionToken() in lib/orgs.js.
//
// Same validation/consumption as the web route (shared via consumeLoginToken)
// — the only difference is how the token gets handed back to the caller.

import { NextResponse } from "next/server";
import { consumeLoginToken } from "../../../../../lib/orgs.js";
import { isMfaEnrolled, issueMfaPendingToken } from "../../../../../lib/mfa.js";

// KNOWN GAP: inaya-mobile has no UI yet for the mfaRequired response shape
// below — this route change is additive for the API, but a mobile member
// who enrolls MFA via the web app will hit an unhandled response on their
// next mobile login until inaya-mobile's own login screen is updated
// separately. Not silently ignored — flagged directly here and in the
// feature's summary.

export async function POST(req) {
  try {
    let { token } = await req.json();
    token = String(token || "").trim();

    // Tolerate the user pasting the full emailed link rather than just the token.
    const match = token.match(/[?&]token=([^&\s]+)/);
    if (match) token = decodeURIComponent(match[1]);

    if (!token) {
      return NextResponse.json({ error: "A login link or code is required." }, { status: 400 });
    }

    const result = await consumeLoginToken(token);
    if (result.error) {
      const message = result.error === "missing_token"
        ? "A login link or code is required."
        : "That link is invalid or has expired — request a new one.";
      return NextResponse.json({ error: message }, { status: result.status });
    }

    if (await isMfaEnrolled(result.email)) {
      const mfaPendingToken = await issueMfaPendingToken(result.email);
      return NextResponse.json({ mfaRequired: true, mfaPendingToken, email: result.email });
    }

    return NextResponse.json({ email: result.email, sessionToken: result.sessionToken });
  } catch (err) {
    console.error("orgs/login/consume-token failed:", err);
    return NextResponse.json({ error: "Could not sign in. Please try again." }, { status: 500 });
  }
}
