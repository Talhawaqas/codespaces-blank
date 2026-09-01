// app/api/orgs/mfa/status/route.js
//
// GET /api/orgs/mfa/status — requires an active session (identity-scoped,
// no orgId needed — MFA protects the login itself, before org context is
// resolved). Never returns secrets, just what's enrolled.

import { NextResponse } from "next/server";
import { getRawSessionToken, getSession } from "../../../../../lib/orgs.js";
import { getMfaStatus } from "../../../../../lib/mfa.js";

export async function GET(req) {
  try {
    const session = await getSession(getRawSessionToken(req));
    if (!session) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

    const status = await getMfaStatus(session.email);
    return NextResponse.json(status);
  } catch (err) {
    console.error("orgs/mfa/status GET failed:", err);
    return NextResponse.json({ error: "Could not load MFA status." }, { status: 500 });
  }
}
