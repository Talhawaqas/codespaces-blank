// app/api/orgs/create/route.js
//
// POST /api/orgs/create
// Body: { orgName, ownerEmail }
//
// Creates the org and its owner membership. Two callers:
//
// - Anonymous (no session cookie/Bearer token) — the original flow: a
//   login magic link is generated for the given ownerEmail and emailed via
//   Resend (also returned directly for local dev without RESEND_API_KEY).
//   Creating an org doesn't itself grant a session this way, so this can't
//   be used to silently claim an email you don't control.
// - Already signed in (e.g. just completed Google sign-in with zero org
//   memberships — see /api/orgs/login/google) — the caller's identity is
//   already verified, so there's no need for a second magic-link round
//   trip. ownerEmail is ignored in favor of the session's own email, and
//   the response is immediate: { orgId, alreadySignedIn: true }.

import { NextResponse } from "next/server";
import {
  getOrgCollections,
  ensureOrgIndexes,
  normalizeEmail,
  isValidEmail,
  generateToken,
  hashToken,
  getRawSessionToken,
  getSession,
  MAGIC_LINK_TTL_MS,
} from "../../../../lib/orgs.js";
import { sendMagicLinkEmail } from "../../../../lib/email.js";
import { assessRisk } from "../../../../lib/fraudRisk.js";

export async function POST(req) {
  try {
    const { orgName, ownerEmail: rawEmail } = await req.json();
    const name = String(orgName || "").trim();
    if (!name) return NextResponse.json({ error: "Company name is required." }, { status: 400 });

    const existingSession = await getSession(getRawSessionToken(req));
    const ownerEmail = existingSession ? existingSession.email : normalizeEmail(rawEmail);

    if (!ownerEmail || !isValidEmail(ownerEmail)) {
      return NextResponse.json({ error: "A valid email is required." }, { status: 400 });
    }

    // Fraud & Abuse Protection Layer, Phase 2 -- monitor-only, same
    // reasoning as orgs/login/request: this is a paying B2B product,
    // corporate VPNs and travelling employees are ordinary legitimate use,
    // so this never blocks org creation, only records the assessment.
    await assessRisk({ req, identityId: ownerEmail, surface: "business" });

    await ensureOrgIndexes();
    const { orgs, orgMembers, magicLinks } = await getOrgCollections();

    const now = new Date().toISOString();
    // plan/planUpdatedAt start null — getOrgPlan() (src/lib/orgPlans.js)
    // treats an org with no plan as unrestricted for LIMIT purposes, which
    // is what we want for orgs that existed before plans did. But a org
    // created from here on is new, on testnet, with real Stripe checkout
    // available — requiresPlanSelection:true tells the frontend to gate
    // the workspace behind picking a plan (or starting its free trial)
    // before showing the Dashboard, instead of quietly granting the same
    // unrestricted access pre-existing orgs get. See business/page.js's
    // PlanSelectionGate.
    const orgResult = await orgs.insertOne({
      name,
      ownerEmail,
      plan: null,
      planUpdatedAt: null,
      requiresPlanSelection: true,
      createdAt: now,
    });
    const orgId = orgResult.insertedId;

    await orgMembers.insertOne({
      orgId,
      email: ownerEmail,
      role: "owner",
      departmentIds: [],
      status: "active",
      invitedAt: now,
      joinedAt: now,
    });

    // Already signed in (e.g. Google) — identity is already verified, no
    // magic-link round trip needed.
    if (existingSession) {
      return NextResponse.json({ orgId: orgId.toString(), alreadySignedIn: true });
    }

    const token = generateToken();
    await magicLinks.insertOne({
      tokenHash: hashToken(token),
      email: ownerEmail,
      orgId: null, // login links aren't org-scoped — a person can belong to multiple orgs
      purpose: "login",
      expiresAt: new Date(Date.now() + MAGIC_LINK_TTL_MS).toISOString(),
      usedAt: null,
      createdAt: now,
    });

    const origin = new URL(req.url).origin;
    const loginUrl = `${origin}/api/orgs/login/consume?token=${token}`;
    const emailResult = await sendMagicLinkEmail({ to: ownerEmail, url: loginUrl, purpose: "login" });

    // Only fall back to returning the link when we couldn't actually email it —
    // otherwise someone creating an org under an email they don't own would get
    // a working login link for it handed straight back to them.
    return NextResponse.json({
      orgId: orgId.toString(),
      emailSent: emailResult.sent,
      ...(emailResult.sent ? {} : { loginUrl }),
    });
  } catch (err) {
    console.error("orgs/create failed:", err);
    return NextResponse.json({ error: "Could not create the company." }, { status: 500 });
  }
}
