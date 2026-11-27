// src/lib/featureFlags.js
//
// Competitive Expansion SOW §55: every new capability sits behind a FEATURE_* flag so it can be rolled out in stages
// (internal -> selected organizations -> everyone) and switched off again without a deploy.
//
// Resolution, strongest first:
//   1. env FEATURE_X = "0" | "off" | "false"   -> OFF for everyone (kill switch, beats everything)
//   2. env FEATURE_X = "1" | "on" | "true"     -> ON for everyone
//   3. org document `features.FEATURE_X === true` -> ON for that organization (selected-organization rollout)
//   4. otherwise                                -> OFF
//
// Existing users and organizations are unaffected until a flag is turned on.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { FLAG_PLAN_FEATURE, DEFAULT_ON_FLAGS, planAllows, PLAN_GATE_PROJECTION } from "./planGates.js";

export const FEATURES = [
  "FEATURE_SECURE_CHAT",
  "FEATURE_SECURE_NOTES",
  "FEATURE_ADVANCED_SHARING",
  "FEATURE_FILE_GOVERNANCE",
  "FEATURE_SMART_CLASSIFICATION",
  "FEATURE_DLP",
  "FEATURE_DRM_VIEWER",
  "FEATURE_DATA_ROOM_V2",
  "FEATURE_RANSOMWARE_SIGNALS",
  "FEATURE_ENDPOINT_BACKUP_V2",
  "FEATURE_DEVICE_CONTROL",
  "FEATURE_SOVEREIGN_GATEWAY",
  "FEATURE_GOVERNMENT_SECURITY_PROFILE",
  "FEATURE_COMPLIANCE_READINESS",
  "FEATURE_CUSTOMER_MANAGED_KEYS",
  "FEATURE_FILE_WORKFLOW_AUTOMATION",
  "FEATURE_PQC",
  "FEATURE_MEET",
  "FEATURE_INFRASTRUCTURE",
  // Inaya Commerce (paid add-on for Business/Enterprise): enabled by Inaya with the add-on, never self-service.
  "FEATURE_COMMERCE",
  // Manage Orders (Work/Repair Orders, technicians, cheques): Business + Enterprise; switched on by Inaya, never self-service.
  "FEATURE_MANAGE_ORDERS",
  // Inaya Connect (WhatsApp Business & AI gateway): Business + Enterprise; switched on by Inaya, never self-service.
  "FEATURE_INAYA_CONNECT",
  // Microsoft Power BI integration (Enterprise): pilot-first rollout, switched on by Inaya, never self-service.
  "FEATURE_POWER_BI",
];

const ON = new Set(["1", "on", "true", "yes"]);
const OFF = new Set(["0", "off", "false", "no"]);

/** Pure: the environment's verdict for one flag: "on", "off", or null (no global opinion). */
export function envFlag(name, env = process.env) {
  const v = String(env[name] ?? "").trim().toLowerCase();
  if (OFF.has(v)) return "off";
  if (ON.has(v)) return "on";
  return null;
}

/** Pure: resolve a flag given the organization's stored flags (may be undefined). */
// `org` (optional): the organization document. When given, a switch that is also a package feature (planGates.js
// FLAG_PLAN_FEATURE) is off below its package, and on by default from it (unless the company switched it off on purpose).
export function resolveFeature(name, orgFeatures, env = process.env, orgPlan = null, org = null) {
  if (!FEATURES.includes(name)) return false;
  const e = envFlag(name, env);
  if (e === "off") return false;
  const planKey = org ? FLAG_PLAN_FEATURE[name] : null;
  if (planKey) {
    if (!planAllows(org, planKey)) return false;
    if (DEFAULT_ON_FLAGS.has(name) && ["business", "enterprise"].includes(org.plan) && orgFeatures?.[name] !== false) return true;
  }
  if (e === "on") return true;
  // Pricing approved 23 Nov 2026: Commerce is INCLUDED in Enterprise (unless switched off for that company on purpose).
  if (name === "FEATURE_COMMERCE" && orgPlan === "enterprise" && orgFeatures?.[name] !== false) return true;
  return orgFeatures?.[name] === true;
}

export async function isFeatureEnabled(name, orgId) {
  if (!FEATURES.includes(name)) return false;
  const e = envFlag(name);
  if (e === "off") return false;
  if (e === "on") return true;
  if (!orgId) return false;
  try {
    const { orgs } = await getOrgCollections();
    const org = await orgs.findOne({ _id: toObjectId(orgId) }, { projection: { features: 1, ...PLAN_GATE_PROJECTION } });
    return resolveFeature(name, org?.features, process.env, org?.plan || null, org || {});
  } catch {
    return false; // fail closed
  }
}

/** Route helper: returns null when the feature is on, else a { error, status } to hand straight back. */
export async function requireFeature(name, orgId) {
  if (await isFeatureEnabled(name, orgId)) return null;
  return { error: "This feature is not enabled for your organization.", status: 404 };
}

/** Owner/admin opt-in for a selected-organization rollout (refused while the env kill switch is on). */
export async function setOrgFeature({ orgId, name, enabled }) {
  if (!FEATURES.includes(name)) return { error: "Unknown feature.", status: 400 };
  if (envFlag(name) === "off") return { error: "This feature is switched off platform-wide.", status: 409 };
  const { orgs } = await getOrgCollections();
  if (enabled && FLAG_PLAN_FEATURE[name]) {
    const org = await orgs.findOne({ _id: toObjectId(orgId) }, { projection: PLAN_GATE_PROJECTION });
    if (!planAllows(org || {}, FLAG_PLAN_FEATURE[name])) return { error: "This feature is not included in your package. Upgrade in Billing to use it.", status: 403, code: "PLAN_UPGRADE_REQUIRED" };
  }
  await orgs.updateOne({ _id: toObjectId(orgId) }, { $set: { [`features.${name}`]: !!enabled } });
  return { ok: true, name, enabled: !!enabled };
}

export async function listOrgFeatures(orgId) {
  const { orgs } = await getOrgCollections();
  const org = await orgs.findOne({ _id: toObjectId(orgId) }, { projection: { features: 1, ...PLAN_GATE_PROJECTION } });
  return FEATURES.map((name) => {
    const planKey = FLAG_PLAN_FEATURE[name];
    const planLocked = !!planKey && envFlag(name) !== "off" && !planAllows(org || {}, planKey);
    const enabled = resolveFeature(name, org?.features, process.env, org?.plan || null, org || {});
    const source = planLocked ? "plan" : envFlag(name) ? "platform" : org?.features?.[name] ? "organization" : enabled ? "package" : "off";
    return { name, enabled, source, ...(planLocked ? { planLocked: true } : {}) };
  });
}
