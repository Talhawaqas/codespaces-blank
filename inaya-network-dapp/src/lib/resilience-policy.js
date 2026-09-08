// src/lib/resilience-policy.js
//
// Autonomous Resilience Layer SOW, Phase 1 — an institution's recovery
// requirements: RTO/RPO thresholds, which critical asset categories to
// keep tested, and how often. Same shape as every other org-config
// workflow in this codebase (canManageOrg-gated, atomic status-guarded
// updates, logOrgActivity on every write) — this file owns policy CRUD
// only; the orchestrator (resilience-orchestrator.js, Phase 2) is what
// actually runs a test against a policy.
//
// evaluateRtoRpo() is also here — the SOW's own literal comparison rule,
// kept next to the policy shape it validates against rather than buried
// inside the orchestrator.

import { getOrgCollections, canManageOrg, toObjectId } from "./orgs.js";
import { logOrgActivity } from "./org-activity-log.js";

export const TEST_FREQUENCIES = ["daily", "weekly", "monthly"];
export const POLICY_STATUSES = ["ACTIVE", "PAUSED"];

function serialize(row) {
  if (!row) return null;
  return {
    policyId: row._id.toString(),
    orgId: row.orgId.toString(),
    name: row.name,
    requiredRTOMinutes: row.requiredRTOMinutes,
    requiredRPOMinutes: row.requiredRPOMinutes,
    criticalAssetCategories: row.criticalAssetCategories,
    testFrequency: row.testFrequency,
    status: row.status,
    lastTestAt: row.lastTestAt || null,
    createdByEmail: row.createdByEmail,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function validateInput({ name, requiredRTOMinutes, requiredRPOMinutes, criticalAssetCategories, testFrequency }) {
  if (!name || typeof name !== "string") return "name is required.";
  if (!Number.isFinite(requiredRTOMinutes) || requiredRTOMinutes <= 0) return "requiredRTOMinutes must be a positive number.";
  if (!Number.isFinite(requiredRPOMinutes) || requiredRPOMinutes <= 0) return "requiredRPOMinutes must be a positive number.";
  if (!Array.isArray(criticalAssetCategories) || criticalAssetCategories.length === 0) return "At least one critical asset category is required.";
  for (const cat of criticalAssetCategories) {
    if (!cat.label || typeof cat.label !== "string") return "Every critical asset category needs a label.";
  }
  if (!TEST_FREQUENCIES.includes(testFrequency)) return `testFrequency must be one of: ${TEST_FREQUENCIES.join(", ")}.`;
  return null;
}

export async function createPolicy({ orgId, name, requiredRTOMinutes, requiredRPOMinutes, criticalAssetCategories, testFrequency, membership, actorEmail }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can create a resilience policy.", status: 403 };
  const validationError = validateInput({ name, requiredRTOMinutes, requiredRPOMinutes, criticalAssetCategories, testFrequency });
  if (validationError) return { error: validationError, status: 400 };

  const { resiliencePolicies } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const now = new Date().toISOString();
  const doc = {
    orgId: orgObjectId, name,
    requiredRTOMinutes, requiredRPOMinutes,
    criticalAssetCategories: criticalAssetCategories.map((c) => ({ label: c.label, priority: c.priority || "STANDARD" })),
    testFrequency, status: "ACTIVE", lastTestAt: null,
    createdByEmail: actorEmail, createdAt: now, updatedAt: now,
  };
  const { insertedId } = await resiliencePolicies.insertOne(doc);
  const row = { ...doc, _id: insertedId };

  await logOrgActivity({ orgId: orgObjectId, recordType: "RESILIENCE_POLICY", recordId: insertedId, actorEmail, action: "RESILIENCE_POLICY_CREATED", previousState: null, newState: "ACTIVE", metadata: { name, requiredRTOMinutes, requiredRPOMinutes } });
  return { policy: serialize(row) };
}

export async function updatePolicy({ orgId, policyId, updates, membership, actorEmail }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can update a resilience policy.", status: 403 };
  const { resiliencePolicies } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const policyObjectId = toObjectId(policyId);

  const existing = await resiliencePolicies.findOne({ _id: policyObjectId, orgId: orgObjectId });
  if (!existing) return { error: "Resilience policy not found.", status: 404 };

  const merged = { ...existing, ...updates };
  if (updates.status && !POLICY_STATUSES.includes(updates.status)) return { error: `status must be one of: ${POLICY_STATUSES.join(", ")}.`, status: 400 };
  const validationError = validateInput(merged);
  if (validationError) return { error: validationError, status: 400 };

  const now = new Date().toISOString();
  const setFields = {
    name: merged.name, requiredRTOMinutes: merged.requiredRTOMinutes, requiredRPOMinutes: merged.requiredRPOMinutes,
    criticalAssetCategories: merged.criticalAssetCategories.map((c) => ({ label: c.label, priority: c.priority || "STANDARD" })),
    testFrequency: merged.testFrequency, status: merged.status || existing.status, updatedAt: now,
  };
  const updated = await resiliencePolicies.findOneAndUpdate({ _id: policyObjectId, orgId: orgObjectId }, { $set: setFields }, { returnDocument: "after" });

  await logOrgActivity({ orgId: orgObjectId, recordType: "RESILIENCE_POLICY", recordId: policyObjectId, actorEmail, action: "RESILIENCE_POLICY_UPDATED", previousState: existing.status, newState: setFields.status, metadata: {} });
  return { policy: serialize(updated) };
}

export async function getPolicy({ orgId, policyId }) {
  const { resiliencePolicies } = await getOrgCollections();
  const row = await resiliencePolicies.findOne({ _id: toObjectId(policyId), orgId: toObjectId(orgId) });
  if (!row) return { error: "Resilience policy not found.", status: 404 };
  return { policy: serialize(row) };
}

export async function listPolicies({ orgId }) {
  const { resiliencePolicies } = await getOrgCollections();
  const rows = await resiliencePolicies.find({ orgId: toObjectId(orgId) }).sort({ createdAt: -1 }).toArray();
  return { policies: rows.map(serialize) };
}

/** The SOW's own literal rule: Actual <= Required -> PASS, else FAIL. */
export function evaluateRtoRpo(policy, actualRTOMinutes, actualRPOMinutes) {
  const rtoPass = actualRTOMinutes <= policy.requiredRTOMinutes;
  const rpoPass = actualRPOMinutes <= policy.requiredRPOMinutes;
  return { rtoPass, rpoPass, overallPass: rtoPass && rpoPass };
}
