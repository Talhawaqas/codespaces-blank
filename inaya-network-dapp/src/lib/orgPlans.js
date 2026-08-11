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

import { getOrgCollections, toObjectId } from "./orgs.js";

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

export function getOrgPlan(org) {
  if (!org?.plan) return LEGACY_UNLIMITED;
  return PLANS[org.plan] || PLANS.starter;
}

// One-shot usage lookup reused by the Billing GET route and both
// enforcement points (invite, document upload) so there's a single place
// that defines what "usage" means for an org.
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
