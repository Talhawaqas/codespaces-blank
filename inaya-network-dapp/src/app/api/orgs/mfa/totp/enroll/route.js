// app/api/orgs/mfa/totp/enroll/route.js
//
// POST /api/orgs/mfa/totp/enroll — requires an active session. Generates
// a new TOTP secret (stored encrypted, pending confirmTotp()) and returns
// the QR code + otpauth:// URI to display. Calling this again before
// confirming simply overwrites the pending secret — no harm, the old one
// was never verified.

import { NextResponse } from "next/server";
import { getRawSessionToken, getSession } from "../../../../../../lib/orgs.js";
import { enrollTotp } from "../../../../../../lib/mfa.js";

export async function POST(req) {
  try {
    const session = await getSession(getRawSessionToken(req));
    if (!session) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

    const result = await enrollTotp(session.email);
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/mfa/totp/enroll POST failed:", err);
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
