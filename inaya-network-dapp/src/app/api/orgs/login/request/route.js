// app/api/orgs/login/request/route.js
//
// POST /api/orgs/login/request
// Body: { email }
//
// For returning users (session expired, new device) rather than first-time
// org creation — generates a fresh login link for any email that's an
// active member of at least one org, and emails it via Resend. Returns the
// same generic { sent: true } whether or not the email is known, so this
// can't be used to enumerate which emails have accounts.
//
// The raw link is only ever included in the JSON response when real
// delivery didn't happen (RESEND_API_KEY unset, or the send failed) —
// once email actually works, leaking the link back to whoever *claims* an
// email address (unauthenticated, by definition — that's the whole point
// of this endpoint) would let anyone log in as anyone just by knowing
// their address, defeating magic-link verification entirely.

import { NextResponse } from "next/server";
import {
  getOrgCollections,
  ensureOrgIndexes,
  normalizeEmail,
  isValidEmail,
  generateToken,
  hashToken,
  MAGIC_LINK_TTL_MS,
} from "../../../../../lib/orgs.js";
import { sendMagicLinkEmail } from "../../../../../lib/email.js";
import { assessRisk } from "../../../../../lib/fraudRisk.js";

export async function POST(req) {
  try {
    const { email: rawEmail } = await req.json();
    const email = normalizeEmail(rawEmail);
    if (!email || !isValidEmail(email)) {
      return NextResponse.json({ error: "A valid email is required." }, { status: 400 });
    }

    await ensureOrgIndexes();
    const { orgMembers, magicLinks } = await getOrgCollections();

    const hasActiveMembership = await orgMembers.findOne({ email, status: "active" });
    if (!hasActiveMembership) {
      return NextResponse.json({ sent: true }); // generic response, see module comment
    }

    // Fraud & Abuse Protection Layer, Phase 2 -- monitor-only for Business
    // Workspace, deliberately never blocking. This is a paying B2B product
    // where corporate VPNs, mobile carrier NAT, and travelling employees
    // are ordinary, legitimate access patterns (the SOW's own section 8
    // names exactly these as cases that must never be auto-penalized) --
    // gating login itself would be actively harmful. The assessment is
    // still recorded (visible in /admin/fraud) so a genuinely abnormal
    // pattern is discoverable, just never auto-enforced here. Awaited (not
    // fire-and-forget) since a serverless function can be frozen right
    // after its response is sent -- assessRisk() itself never throws (see
    // its own comment), so this only ever adds latency, never a new
    // failure mode.
    await assessRisk({ req, identityId: email, surface: "business" });

    const token = generateToken();
    await magicLinks.insertOne({
      tokenHash: hashToken(token),
      email,
      orgId: null,
      purpose: "login",
      expiresAt: new Date(Date.now() + MAGIC_LINK_TTL_MS).toISOString(),
      usedAt: null,
      createdAt: new Date().toISOString(),
    });

    const origin = new URL(req.url).origin;
    const loginUrl = `${origin}/api/orgs/login/consume?token=${token}`;
    const emailResult = await sendMagicLinkEmail({ to: email, url: loginUrl, purpose: "login" });

    // Only fall back to returning the link when we couldn't actually email it —
    // see the module comment for why this matters once delivery is configured.
    return NextResponse.json({ sent: true, ...(emailResult.sent ? {} : { loginUrl }) });
  } catch (err) {
    console.error("orgs/login/request failed:", err);
    return NextResponse.json({ error: "Could not generate a login link." }, { status: 500 });
  }
}
