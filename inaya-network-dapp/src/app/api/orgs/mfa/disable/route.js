// app/api/orgs/mfa/disable/route.js
//
// POST /api/orgs/mfa/disable  Body: { code }
// Requires an active session AND a valid live code (TOTP, SMS, or a
// recovery code) first — never a bare toggle. Removes the whole
// member_mfa record; re-enrolling either method afterward starts fresh.

import { NextResponse } from "next/server";
import { getRawSessionToken, getSession } from "../../../../../lib/orgs.js";
import { disableMfa } from "../../../../../lib/mfa.js";

export async function POST(req) {
  try {
    const session = await getSession(getRawSessionToken(req));
    if (!session) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

    const { code } = await req.json();
    const result = await disableMfa(session.email, code);
    return NextResponse.json(result);
  } catch (err) {
    console.error("orgs/mfa/disable POST failed:", err);
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
