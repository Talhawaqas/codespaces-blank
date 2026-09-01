// app/api/orgs/mfa/send-sms/route.js
//
// POST /api/orgs/mfa/send-sms  Body: { mfaPendingToken }
//
// "Resend code" during the login-time SMS verify step. No active session
// required (same reasoning as mfa/verify) — the pending token itself is
// what's authenticated, and sendLoginSmsForPendingToken() resolves the
// real account server-side rather than trusting a client-supplied email.

import { NextResponse } from "next/server";
import { sendLoginSmsForPendingToken } from "../../../../../lib/mfa.js";

export async function POST(req) {
  try {
    const { mfaPendingToken } = await req.json();
    if (!mfaPendingToken) return NextResponse.json({ error: "mfaPendingToken is required." }, { status: 400 });

    const result = await sendLoginSmsForPendingToken(mfaPendingToken);
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/mfa/send-sms POST failed:", err);
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
