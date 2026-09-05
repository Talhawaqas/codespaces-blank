// src/lib/orgPlans.js
//
// Single source of truth for the Business Workspace's 4 pricing tiers —
// mirrors the saasRoadmap.js convention of one canonical content file that
// both the pricing page and the in-app Billing view render from, so the
// two surfaces can never drift.
//
// Orgs created before this file existed (and any org that simply hasn't
// picked a plan yet) have no `plan` field at all — getOrgPlan() treats
// that as "legacy/unrestricted" rather than defaulting them into Starter's
// limits, so nothing that already worked for an existing org breaks the
// moment this ships. An org only becomes limited once its owner explicitly
// picks a plan (self-serve checkout) or Enterprise is assigned manually.

import { getOrgCollections, toObjectId, generateToken, hashToken, MAGIC_LINK_TTL_MS } from "./orgs.js";
import { sendNoPlanReminderEmail } from "./email.js";

export const PLANS = {
  starter: {
    id: "starter",
    name: "Starter",
    tagline: "For individuals and small teams getting started.",
    color: "green",
    priceMonthly: 7.99,
    priceYearly: 79,
    maxUsers: 2,
    maxStorageGB: 250,
    maxFileSizeMB: 5,
    features: [
      "2 Users",
      "250 GB Secure Storage",
      "Client-side Encryption",
      "Passkey Authentication",
      "Secure File Sharing",
      "File Version History",
      "Basic AI Assistant",
      "Mobile & Web Access",
      "5 GB Max File Size",
    ],
  },
  professional: {
    id: "professional",
    name: "Professional",
    tagline: "For growing teams and professional businesses.",
    color: "blue",
    popular: true,
    priceMonthly: 28,
    priceYearly: 280,
    maxUsers: 5,
    maxStorageGB: 1000,
    maxFileSizeMB: 10,
    features: [
      "5 Users",
      "1 TB Secure Storage",
      "Everything in Starter",
      "Advanced File Sharing",
      "Team Folders",
      "Role-based Permissions",
      "Advanced Activity Logs",
      "AI Document Assistant",
      "10 GB Max File Size",
      "Priority Support",
    ],
  },
  business: {
    id: "business",
    name: "Business",
    tagline: "For organizations managing sensitive data.",
    color: "purple",
    priceMonthly: 49.99,
    priceYearly: 499,
    maxUsers: 10,
    maxStorageGB: 5000,
    maxFileSizeMB: 25,
    features: [
      "10 Users",
      "5 TB Secure Storage",
      "Everything in Professional",
      "Advanced Admin Dashboard",
      "Organization-wide Policies",
      "Advanced Audit Logs",
      "Device & Session Management",
      "Secure Client Portals",
      "Custom Domain",
      "Advanced AI Assistant",
      "API Access",
      "25 GB Max File Size",
      "Priority Support",
    ],
  },
  enterprise: {
    id: "enterprise",
    name: "Enterprise",
    tagline: "For enterprises requiring maximum security, control and support.",
    color: "gold",
    contactSalesOnly: true,
    priceMonthly: 799,
    priceYearly: 7990,
    maxUsers: 25,
    maxStorageGB: 10000,
    maxFileSizeMB: 100,
    features: [
      "Up to 25 Users",
      "10 TB Secure Storage",
      "Everything in Business",
      "Advanced Security & Compliance",
      "SSO & Advanced Admin Controls",
      "Advanced Audit & Activity Logs",
      "Custom Retention Policies",
      "API Access & Integrations",
      "Dedicated Onboarding",
      "SLA & Priority Support",
      "Enterprise Security Configuration",
      "50+ Users or 50+ TB? Contact Sales",
    ],
  },
};

export const PLAN_ORDER = ["starter", "professional", "business", "enterprise"];

// Any org with no `plan` field is grandfathered unrestricted — see file
// header. `id: null` deliberately doesn't match any real PLANS key.
export const LEGACY_UNLIMITED = {
  id: null,
  name: "Legacy (Unrestricted)",
  tagline: "Grandfathered — no plan selected yet.",
  color: "cyan",
  maxUsers: Infinity,
  maxStorageGB: Infinity,
  maxFileSizeMB: Infinity,
  features: [],
};

// "Continue without plan" — a new org that explicitly declines checkout
// (see /api/orgs/billing/continue-without-plan) rather than a pre-existing
// org that simply predates plan selection. Distinct from LEGACY_UNLIMITED
// on purpose: the user asked for this to carry Starter's real limits, not
// the unrestricted grandfather treatment — an org that actively chose
// "no plan" is a genuinely different case from one that was never asked.
// Same maxUsers/maxStorageGB/maxFileSizeMB as PLANS.starter so every
// existing enforcement call site (invite, upload) needs zero changes;
// price fields are zeroed and the name says so, so Billing UI never
// implies this org is being charged.
export const NO_PLAN_LIMITED = {
  ...PLANS.starter,
  id: "starter",
  name: "Starter (No Billing)",
  tagline: "Limited features, selected without billing — upgrade anytime.",
  priceMonthly: 0,
  priceYearly: 0,
  noBilling: true,
};

export function getOrgPlan(org) {
  if (org?.plan) return PLANS[org.plan] || PLANS.starter;
  if (org?.noPlanConfirmedAt) return NO_PLAN_LIMITED;
  return LEGACY_UNLIMITED;
}

// One-shot usage lookup reused by the Billing GET route and both
// enforcement points (invite, document upload) so there's a single place
// that defines what "usage" means for an org.
// Healthcare & Legal Expansion follow-on — nudges an org owner stuck at
// the plan-selection gate (requiresPlanSelection still true, no plan, and
// never explicitly continued for free) toward finishing setup. Cron-
// driven (api/cron/no-plan-reminders), same idempotent-via-marker
// discipline as invoice-workflow.js's markOverdueInvoices and
// health-scheduling.js's appointment reminders: sent exactly once per
// org via a findOneAndUpdate that only succeeds if noPlanReminderSentAt
// isn't already set, so a concurrent/repeated cron run can't double-send.
// Waits 24h past creation first so someone still mid-signup isn't
// immediately emailed.
//
// `orgIds` (optional): scopes the scan to exactly these org IDs instead
// of the whole `orgs` collection. The real cron always omits it (a full
// scan is the entire point). This exists ONLY so automated tests can
// call the real function without touching real user data — this
// function sends actual emails to actual people, unlike e.g.
// markOverdueInvoices()'s plain status flip, so "just run it against the
// shared test database and hope only fixture rows match" is not an
// acceptable testing strategy here. A real incident during this
// implementation (an early test run, before this parameter existed,
// matched ~68 real production orgs and stamped them as reminded even
// though RESEND_API_KEY wasn't configured locally to actually send —
// caught and reverted, but exactly the failure mode this guards against).
export async function sendNoPlanReminders({ orgIds } = {}) {
  const { orgs, magicLinks } = await getOrgCollections();
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const query = { requiresPlanSelection: true, plan: null, noPlanConfirmedAt: { $exists: false }, noPlanReminderSentAt: { $exists: false }, createdAt: { $lt: cutoff } };
  if (orgIds) query._id = { $in: orgIds.map((id) => toObjectId(id)) };
  const stuck = await orgs.find(query).toArray();

  let sent = 0;
  for (const org of stuck) {
    const claimed = await orgs.findOneAndUpdate(
      { _id: org._id, noPlanReminderSentAt: { $exists: false } },
      { $set: { noPlanReminderSentAt: new Date().toISOString() } }
    );
    if (!claimed) continue; // already claimed by a concurrent run

    const token = generateToken();
    await magicLinks.insertOne({
      tokenHash: hashToken(token), email: org.ownerEmail, orgId: null, purpose: "login",
      expiresAt: new Date(Date.now() + MAGIC_LINK_TTL_MS).toISOString(), usedAt: null, createdAt: new Date().toISOString(),
    });
    const origin = process.env.NEXT_PUBLIC_APP_URL;
    if (!origin) continue; // can't build a working link without a configured origin
    const url = `${origin}/api/orgs/login/consume?token=${token}`; // this route always redirects into /business on success
    await sendNoPlanReminderEmail({ to: org.ownerEmail, orgName: org.name, url });
    sent += 1;
  }
  return { checked: stuck.length, sent };
}

export async function getOrgUsage(orgId) {
  const { orgMembers, orgDocuments } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);

  const [activeUsers, storageAgg] = await Promise.all([
    orgMembers.countDocuments({ orgId: orgObjectId, status: "active" }),
    orgDocuments
      .aggregate([
        { $match: { orgId: orgObjectId, deletedAt: null } },
        { $group: { _id: null, totalBytes: { $sum: "$sizeBytes" } } },
      ])
      .toArray(),
  ]);

  return {
    activeUsers,
    storageUsedBytes: storageAgg[0]?.totalBytes || 0,
  };
}
