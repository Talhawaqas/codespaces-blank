// app/api/orgs/invite/route.js
//
// POST /api/orgs/invite
// Body: { orgId, email, role, departmentIds }
//
// Owner/admin only. Creates an "invited" member row and an invite-purpose
// magic link, and emails it to the invitee — consuming that link
// (GET /api/orgs/login/consume) both logs them in AND flips their
// membership to "active" in one step. The link is also always returned to
// the caller here (unlike login/request) since the caller is an already-
// authenticated admin choosing to invite someone, not an unverified
// claimant of the invitee's email — there's no harm in giving the admin a
// copy to forward manually if they want a backup to email delivery.

import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import {
  getOrgCollections,
  ensureOrgIndexes,
  requireMembership,
  normalizeEmail,
  isValidEmail,
  generateToken,
  hashToken,
  toObjectId,
  ROLES,
  MAGIC_LINK_TTL_MS,
} from "../../../../lib/orgs.js";
import { sendMagicLinkEmail } from "../../../../lib/email.js";
import { getOrgPlan, getOrgUsage } from "../../../../lib/orgPlans.js";

export async function POST(req) {
  try {
    const { orgId, email: rawEmail, role = "member", departmentIds = [] } = await req.json();
    const email = normalizeEmail(rawEmail);

    if (!orgId) return NextResponse.json({ error: "orgId is required." }, { status: 400 });
    if (!email || !isValidEmail(email)) return NextResponse.json({ error: "A valid email is required." }, { status: 400 });
    if (!ROLES.includes(role) || role === "owner") {
      return NextResponse.json({ error: `role must be one of: ${ROLES.filter((r) => r !== "owner").join(", ")}` }, { status: 400 });
    }

    await ensureOrgIndexes();
    const auth = await requireMembership(req, orgId, { requireManage: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });

    const { orgs, orgMembers, magicLinks } = await getOrgCollections();
    const orgObjectId = toObjectId(orgId);
    const org = await orgs.findOne({ _id: orgObjectId });

    const existing = await orgMembers.findOne({ orgId: orgObjectId, email });
    if (existing?.status === "active") {
      return NextResponse.json({ error: "That person is already a member." }, { status: 409 });
    }

    // Seat limit — an "invited" (not-yet-accepted) row doesn't count
    // against the limit here (getOrgUsage only counts status:"active"), so
    // re-sending a pending invite never double-charges a seat.
    const plan = getOrgPlan(org);
    if (plan.maxUsers !== Infinity) {
      const { activeUsers } = await getOrgUsage(orgId);
      if (activeUsers >= plan.maxUsers) {
        return NextResponse.json(
          { error: `Your ${plan.name} plan allows up to ${plan.maxUsers} users. Upgrade to invite more.` },
          { status: 403 }
        );
      }
    }

    const now = new Date().toISOString();
    const departmentObjectIds = departmentIds.map((id) => new ObjectId(id));
    await orgMembers.updateOne(
      { orgId: orgObjectId, email },
      { $set: { orgId: orgObjectId, email, role, departmentIds: departmentObjectIds, status: "invited", invitedAt: now } },
      { upsert: true }
    );

    const token = generateToken();
    await magicLinks.insertOne({
      tokenHash: hashToken(token),
      email,
      orgId: orgObjectId,
      purpose: "invite",
      expiresAt: new Date(Date.now() + MAGIC_LINK_TTL_MS).toISOString(),
      usedAt: null,
      createdAt: now,
    });

    const origin = new URL(req.url).origin;
    const inviteUrl = `${origin}/api/orgs/login/consume?token=${token}`;
    const emailResult = await sendMagicLinkEmail({ to: email, url: inviteUrl, purpose: "invite", orgName: org?.name || "your team" });

    return NextResponse.json({ invited: true, inviteUrl, emailSent: emailResult.sent });
  } catch (err) {
    console.error("orgs/invite failed:", err);
    return NextResponse.json({ error: "Could not send the invite." }, { status: 500 });
  }
}
