// app/api/orgs/create/route.js
//
// POST /api/orgs/create
// Body: { orgName, ownerEmail }
//
// Creates the org and its owner membership, then immediately generates a
// login link for that owner (same magic-link mechanism as any other
// login — creating an org doesn't itself grant a session, so this can't
// be used to silently claim an email you don't control) and emails it via
// Resend. The link is also returned directly in the response — useful for
// testing, and a fallback for local dev where RESEND_API_KEY isn't set.

import { NextResponse } from "next/server";
import {
  getOrgCollections,
  ensureOrgIndexes,
  normalizeEmail,
  isValidEmail,
  generateToken,
  hashToken,
  MAGIC_LINK_TTL_MS,
} from "../../../../lib/orgs.js";
import { sendMagicLinkEmail } from "../../../../lib/email.js";

export async function POST(req) {
  try {
    const { orgName, ownerEmail: rawEmail } = await req.json();
    const name = String(orgName || "").trim();
    const ownerEmail = normalizeEmail(rawEmail);

    if (!name) return NextResponse.json({ error: "Company name is required." }, { status: 400 });
    if (!ownerEmail || !isValidEmail(ownerEmail)) {
      return NextResponse.json({ error: "A valid email is required." }, { status: 400 });
    }

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
