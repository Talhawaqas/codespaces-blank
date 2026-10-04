// src/lib/aiSecurity/orgPolicy.js
//
// Inaya AI Security Workflow 2026 SOW, Phase 24 (§29). Per-org AI
// security policy, versioned. Follows the exact pattern established
// tonight for NAS (envelope-encrypted secrets get their own collection;
// policy documents get their own versioned collection) -- ordinary AI
// users can read the active policy (so the UI can explain a decision),
// only an org manager can change it, and every version is kept, never
// overwritten in place, so a "Why was this blocked?" answer from six
// months ago still resolves against the policy that was actually active
// then.

import { getOrgCollections, toObjectId, canManageOrg } from "../orgs.js";
import { logOrgActivity } from "../org-activity-log.js";

export const DEFAULT_AI_POLICY = Object.freeze({
  allowExternalModels: false,
  allowSensitiveData: false,
  requireHumanApprovalForHighRisk: true,
  maxTokenBudget: 100000,
  allowedProviders: ["google"],
  retentionDays: 30,
});

/** Providers an org may allow. Mirrors the model registry; an unknown name is rejected rather than silently stored. */
export const KNOWN_PROVIDERS = ["google", "groq"];
export const POLICY_LIMITS = Object.freeze({ maxTokenBudget: [1000, 2_000_000], retentionDays: [1, 3650] });
const POLICY_BOOLEANS = ["allowExternalModels", "allowSensitiveData", "requireHumanApprovalForHighRisk"];

/** Whitelist + type/range check for a policy patch. Returns { error } or { patch } containing only known, well-typed fields. */
export function validatePolicyPatch(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { error: "policy must be an object." };
  const patch = {};
  const known = new Set([...POLICY_BOOLEANS, "maxTokenBudget", "retentionDays", "allowedProviders"]);
  const unknown = Object.keys(input).filter((k) => !known.has(k));
  if (unknown.length) return { error: `Unknown policy setting: ${unknown.join(", ")}.` };
  for (const k of POLICY_BOOLEANS) if (k in input) { if (typeof input[k] !== "boolean") return { error: `${k} must be true or false.` }; patch[k] = input[k]; }
  for (const k of ["maxTokenBudget", "retentionDays"]) if (k in input) {
    const [lo, hi] = POLICY_LIMITS[k];
    if (!Number.isInteger(input[k]) || input[k] < lo || input[k] > hi) return { error: `${k} must be a whole number between ${lo} and ${hi}.` };
    patch[k] = input[k];
  }
  if ("allowedProviders" in input) {
    const p = input.allowedProviders;
    if (!Array.isArray(p) || p.length === 0 || !p.every((x) => typeof x === "string")) return { error: "allowedProviders must list at least one provider." };
    const bad = p.filter((x) => !KNOWN_PROVIDERS.includes(x));
    if (bad.length) return { error: `Unknown provider: ${bad.join(", ")}. Known providers: ${KNOWN_PROVIDERS.join(", ")}.` };
    patch.allowedProviders = [...new Set(p)];
  }
  if (!Object.keys(patch).length) return { error: "No policy settings were provided." };
  return { patch };
}

export async function getOrgAiPolicy(orgId) {
  // Public / wallet-scoped surfaces have no organization: platform default policy.
  if (!orgId) return { ...DEFAULT_AI_POLICY, policyId: "default", version: 0 };
  const { aiSecurityPolicies } = await getOrgCollections();
  const active = await aiSecurityPolicies.findOne({ orgId: toObjectId(orgId), active: true });
  if (!active) return { ...DEFAULT_AI_POLICY, policyId: "default", version: 0 };
  return { ...DEFAULT_AI_POLICY, ...active.policy, policyId: active._id.toString(), version: active.version };
}

export async function setOrgAiPolicy({ orgId, policy, membership, actorEmail }) {
  if (!canManageOrg(membership)) return { error: "Only an org owner or admin can change the AI security policy.", status: 403 };

  const checked = validatePolicyPatch(policy);
  if (checked.error) return { error: checked.error, status: 400 };

  const { aiSecurityPolicies } = await getOrgCollections();
  const current = await aiSecurityPolicies.findOne({ orgId: toObjectId(orgId), active: true });
  const nextVersion = (current?.version || 0) + 1;
  const now = new Date().toISOString();

  const merged = { ...DEFAULT_AI_POLICY, ...(current?.policy || {}), ...checked.patch };

  if (current) {
    await aiSecurityPolicies.updateOne({ _id: current._id }, { $set: { active: false, deactivatedAt: now } });
  }
  const { insertedId } = await aiSecurityPolicies.insertOne({
    orgId: toObjectId(orgId), version: nextVersion, policy: merged,
    active: true, createdByEmail: actorEmail, createdAt: now, deactivatedAt: null,
  });

  await logOrgActivity({
    orgId, recordType: "AI_SECURITY_POLICY", recordId: insertedId, actorEmail,
    action: "POLICY_CHANGED", previousState: current ? `v${current.version}` : null, newState: `v${nextVersion}`,
    metadata: { policy: merged },
  });

  return { policy: { ...merged, policyId: insertedId.toString(), version: nextVersion } };
}

export async function listOrgAiPolicyVersions({ orgId, membership }) {
  if (!canManageOrg(membership)) return { error: "Only an org owner or admin can view policy history.", status: 403 };
  const { aiSecurityPolicies } = await getOrgCollections();
  const rows = await aiSecurityPolicies.find({ orgId: toObjectId(orgId) }).sort({ version: -1 }).toArray();
  return { versions: rows };
}
