// app/api/orgs/mfa/totp/confirm/route.js
//
// POST /api/orgs/mfa/totp/confirm  Body: { code }
// Requires an active session. Verifies the first real code from the
// authenticator app; on success returns recoveryCodes ONCE (null if this
// account already has a set from an earlier enrollment) — the client
// must show these to the user immediately, they can never be retrieved
// again after this response.

import { NextResponse } from "next/server";
import { getRawSessionToken, getSession } from "../../../../../../lib/orgs.js";
import { confirmTotp } from "../../../../../../lib/mfa.js";

export async function POST(req) {
  try {
    const session = await getSession(getRawSessionToken(req));
    if (!session) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

    const { code } = await req.json();
    const result = await confirmTotp(session.email, code);
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/mfa/totp/confirm POST failed:", err);
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
