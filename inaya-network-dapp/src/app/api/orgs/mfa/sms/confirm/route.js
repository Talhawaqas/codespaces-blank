// app/api/orgs/mfa/sms/confirm/route.js
//
// POST /api/orgs/mfa/sms/confirm  Body: { code }
// Requires an active session. Verifies the OTP just texted by
// enrollSms(); on success returns recoveryCodes ONCE (null if this
// account already has a set).

import { NextResponse } from "next/server";
import { getRawSessionToken, getSession } from "../../../../../../lib/orgs.js";
import { confirmSms } from "../../../../../../lib/mfa.js";

export async function POST(req) {
  try {
    const session = await getSession(getRawSessionToken(req));
    if (!session) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

    const { code } = await req.json();
    const result = await confirmSms(session.email, code);
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/mfa/sms/confirm POST failed:", err);
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
