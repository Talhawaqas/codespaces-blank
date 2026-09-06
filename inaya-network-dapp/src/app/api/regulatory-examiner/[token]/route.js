// app/api/regulatory-examiner/[token]/route.js
//
// GET /api/regulatory-examiner/[token] — the external examiner's own
// entry point, deliberately OUTSIDE src/app/api/orgs/* and its
// requireMembership()/requireVertical() gate: an outside auditor is not
// an org_member and never will be. Exchanges the magic link for a
// session cookie, exactly mirroring dataroom/verify/route.js's shape —
// see regulatory-examination-access.js's header for why a new, small,
// properly org-scoped construct was built instead of reusing the
// (deliberately non-multi-tenant) Data Room.
//
// Explicitly excluded from test/vertical-lock-wiring.test.mjs — this
// route has no orgId query param and no membership concept at all.

import { NextResponse } from "next/server";
import { exchangeMagicLink, EXAMINER_SESSION_COOKIE } from "../../../../lib/regulatory-examination-access.js";

export const dynamic = "force-dynamic";

export async function GET(req, { params }) {
  try {
    const { token } = await params;
    const result = await exchangeMagicLink(token);
    if (result.error) {
      return NextResponse.json({ error: "This link is invalid or has expired." }, { status: result.status });
    }

    const response = NextResponse.json({ verified: true, examinationId: result.examinationId });
    response.cookies.set(EXAMINER_SESSION_COOKIE, result.sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV !== "development",
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60,
      path: "/",
    });
    return response;
  } catch (err) {
    console.error("regulatory-examiner/[token] failed:", err);
    return NextResponse.json({ error: "Could not verify this link." }, { status: 500 });
  }
}
