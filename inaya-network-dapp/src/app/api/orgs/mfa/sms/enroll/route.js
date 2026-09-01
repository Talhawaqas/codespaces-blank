// app/api/orgs/mfa/sms/enroll/route.js
//
// POST /api/orgs/mfa/sms/enroll  Body: { phoneNumber }  (E.164, e.g. +15551234567)
// Requires an active session. Sends a real OTP via the configured SMS
// provider (fails with a clear "not configured yet" error if none is —
// see smsProviders/twilio.js's header for the honest gap this session
// left).

import { NextResponse } from "next/server";
import { getRawSessionToken, getSession } from "../../../../../../lib/orgs.js";
import { enrollSms } from "../../../../../../lib/mfa.js";

export async function POST(req) {
  try {
    const session = await getSession(getRawSessionToken(req));
    if (!session) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

    const { phoneNumber } = await req.json();
    const result = await enrollSms(session.email, phoneNumber);
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/mfa/sms/enroll POST failed:", err);
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
