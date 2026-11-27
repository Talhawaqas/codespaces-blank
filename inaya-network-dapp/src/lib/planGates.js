// src/lib/planGates.js
//
// Which package each premium capability belongs to: the pricing cards in orgPlans.js, enforced on the server.
// Founder rule (26 Nov 2026): special modules stay in Business and Enterprise so those packages keep their value.
//
// Who passes a gate:
//   * an organization with no package at all (legacy, unrestricted; see orgPlans.js getOrgPlan) - unchanged, as before;
//   * an organization whose package is at or above the capability's package;
//   * an organization stamped `planGrandfatheredAt` (founder decision 26 Nov 2026: "lock, keep existing"): it already had
//     a smaller package when these gates shipped, so nothing it was using is taken away.
// Everyone else gets a 403 that names the package to upgrade to.

import { PLANS, PLAN_ORDER, getOrgPlan } from "./orgPlans.js";
import { getOrgCollections, toObjectId } from "./orgs.js";
import { FEATURE_ADD_ON, hasAddOn, addOnForPlan } from "./addOns.js";

export const PLAN_FEATURES = {
  advancedSharing: { min: "professional", label: "Advanced file sharing" },
  rolePermissions: { min: "professional", label: "Role-based permissions" },
  activityLogs: { min: "professional", label: "Advanced activity logs" },
  documentAi: { min: "professional", label: "The AI document assistant" },
  adminDashboard: { min: "business", label: "The advanced admin dashboard" },
  orgPolicies: { min: "business", label: "Organization-wide policies" },
  auditLogs: { min: "business", label: "Advanced audit logs" },
  deviceControl: { min: "business", label: "Device and session management" },
  clientPortal: { min: "business", label: "Secure client portals" },
  customDomain: { min: "business", label: "A custom domain" },
  advancedAi: { min: "business", label: "The advanced AI assistant" },
  apiAccess: { min: "business", label: "API access" },
  sso: { min: "enterprise", label: "Single sign-on (SSO)", isNew: true }, // did not exist before the gates, so nothing to keep
  retentionPolicies: { min: "enterprise", label: "Custom retention policies" },
  advancedCompliance: { min: "enterprise", label: "Advanced security and compliance" },
  enterpriseSecurity: { min: "enterprise", label: "Enterprise security configuration" },
  payroll: { min: "business", label: "Payroll", isNew: true }, // owner decision 27 Nov 2026: Business + Enterprise; Professional add-on $35 / PKR 7,500
  powerBi: { min: "enterprise", label: "Microsoft Power BI integration", isNew: true }, // owner decisions 27 Nov 2026: Enterprise, or Business with the $79 / PKR 10,000 add-on (addOns.js)
};

/** Beta switches that are also package features: the switch only works on the right package. */
export const FLAG_PLAN_FEATURE = {
  FEATURE_ADVANCED_SHARING: "advancedSharing",
  FEATURE_DEVICE_CONTROL: "deviceControl",
  FEATURE_COMPLIANCE_READINESS: "advancedCompliance",
  FEATURE_GOVERNMENT_SECURITY_PROFILE: "enterpriseSecurity",
  FEATURE_CUSTOMER_MANAGED_KEYS: "enterpriseSecurity",
  FEATURE_POWER_BI: "powerBi",
};
/** Package switches that are on by default once the package includes them (a company can still switch them off). */
// Power BI (owner approval 27 Nov 2026): on for Enterprise, and for Business once the add-on is bought.
export const DEFAULT_ON_FLAGS = new Set(["FEATURE_DEVICE_CONTROL", "FEATURE_POWER_BI"]);

/** Pure: may this organization use the capability? `org` needs plan, extraUsers, noPlanConfirmedAt, planGrandfatheredAt. */
export function planAllows(org, key) {
  const f = PLAN_FEATURES[key];
  if (!f) return false;
  const plan = getOrgPlan(org);
  if (plan.id === null) return true; // legacy, unrestricted
  if (org?.planGrandfatheredAt && !f.isNew) return true;
  if (FEATURE_ADD_ON[key] && hasAddOn(org, FEATURE_ADD_ON[key])) return true; // bought as a Professional add-on
  return PLAN_ORDER.indexOf(plan.id) >= PLAN_ORDER.indexOf(f.min);
}

/** Pure: the message for a refused capability. */
export function planGateMessage(org, key) {
  const f = PLAN_FEATURES[key]; const plan = getOrgPlan(org);
  const target = PLANS[f.min].name;
  const addOn = FEATURE_ADD_ON[key] && addOnForPlan(FEATURE_ADD_ON[key], plan.id);
  return `${f.label} is included in the ${target}${f.min === "enterprise" ? "" : " and Enterprise"} package${f.min === "enterprise" ? "" : "s"}. Your company is on ${plan.name}. ${addOn ? "Add it in Billing > Add-ons, or upgrade" : "Upgrade in Billing"} to use it.`;
}

export const PLAN_GATE_PROJECTION = { plan: 1, extraUsers: 1, noPlanConfirmedAt: 1, planGrandfatheredAt: 1, addOns: 1 };

/** Route helper: null when allowed, else { error, status: 403, code: "PLAN_UPGRADE_REQUIRED", requiredPlan }. */
export async function requirePlanFeature(orgId, key, org = null) {
  if (!PLAN_FEATURES[key]) throw new Error(`Unknown plan feature ${key}`);
  let o = org;
  if (!o || !("plan" in o)) {
    const { orgs } = await getOrgCollections();
    o = await orgs.findOne({ _id: toObjectId(orgId) }, { projection: PLAN_GATE_PROJECTION });
  }
  if (planAllows(o, key)) return null;
  return { error: planGateMessage(o, key), status: 403, code: "PLAN_UPGRADE_REQUIRED", requiredPlan: PLAN_FEATURES[key].min };
}

/** Every capability with whether this organization has it, for the Billing view and the in-app upgrade prompts. */
export function planFeatureMap(org) {
  return Object.fromEntries(Object.entries(PLAN_FEATURES).map(([k, f]) => [k, { allowed: planAllows(org, k), requiredPlan: f.min, label: f.label }]));
}
