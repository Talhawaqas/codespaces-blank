// app/api/education-guardian/[token]/route.js
//
// GET /api/education-guardian/[token] — the parent/guardian's read-only view
// of one student (fee statement, attendance rate, published results).
// Deliberately OUTSIDE src/app/api/orgs/*: a guardian isn't an org member,
// so there's no requireMembership(); the token is the credential, and
// guardianLinks.js checks expiry, revocation, erasure and that the school is
// still on the education vertical. Rate-limited per IP so tokens can't be
// guessed at speed (they're 256-bit anyway).

import { NextResponse } from "next/server";
import { resolveGuardianLink } from "../../../../lib/education/guardianLinks.js";
import { slidingWindowCheck, getClientIp } from "../../../../lib/rateLimit.js";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" };

export async function GET(req, { params }) {
  try {
    const limit = await slidingWindowCheck({ action: "education-guardian-view", key: getClientIp(req), max: 60, windowMs: 10 * 60 * 1000 });
    if (!limit.allowed) return NextResponse.json({ error: "Too many requests. Please wait a few minutes." }, { status: 429, headers: { ...headers, "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) } });
    const { token } = await params;
    const result = await resolveGuardianLink(token);
    if (result.error) return NextResponse.json({ error: result.error }, { status: result.status, headers });
    return NextResponse.json(result.view, { headers });
  } catch (err) {
    console.error("education-guardian GET failed:", err?.name, String(err?.message || "").slice(0, 200));
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500, headers });
  }
}
