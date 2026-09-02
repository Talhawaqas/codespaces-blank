// app/api/orgs/mfa/sms/enroll/route.js
//
// POST /api/orgs/mfa/sms/enroll  Body: { idToken }
// Requires an active session. The client already completed the real
// Firebase Phone Auth flow (FirebasePhoneAuth.js) and is handing over the
// resulting signed ID token — enrollSms() independently re-verifies it
// server-side (firebaseAdmin.js) before recording anything. No separate
// confirm step: phone possession is already proven by the time this is
// called.

import { NextResponse } from "next/server";
import { getRawSessionToken, getSession } from "../../../../../../lib/orgs.js";
import { enrollSms } from "../../../../../../lib/mfa.js";

export async function POST(req) {
  try {
    const session = await getSession(getRawSessionToken(req));
    if (!session) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

    const { idToken } = await req.json();
    const result = await enrollSms(session.email, idToken);
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/mfa/sms/enroll POST failed:", err);
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
