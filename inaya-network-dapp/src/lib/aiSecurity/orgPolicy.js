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

  const { aiSecurityPolicies } = await getOrgCollections();
  const current = await aiSecurityPolicies.findOne({ orgId: toObjectId(orgId), active: true });
  const nextVersion = (current?.version || 0) + 1;
  const now = new Date().toISOString();

  const merged = { ...DEFAULT_AI_POLICY, ...(current?.policy || {}), ...policy };

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
