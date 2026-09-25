// src/lib/aiSecurity/events.js
//
// Inaya AI Security Workflow 2026 SOW, Phase 10/11/31 (§15, §16, §36).
// Records one AISecurityEvent per gateway decision, matching SOW §47's
// schema. Three real writes happen here, not a second audit chain:
//   1. aiSecurityChecks (this module's own record -- the "subject" a
//      Business Event references, never copied elsewhere)
//   2. logOrgActivity() -- the EXISTING cryptographic audit chain
//      (auditChain.js) every other domain module in this codebase uses
//   3. createBusinessEvent() -- the EXISTING Evidence Graph, only for
//      consequential (non-ALLOW) decisions, so routine allowed requests
//      don't flood the graph (same restraint businessEvents.js's own
//      notifyManagersOfHighRiskEvent applies to notifications)
//
// Phase 31's privacy-preserving-logging rule is enforced structurally
// here: inputPreview/outputPreview are only ever stored for non-ALLOW
// decisions (the cases where a human might actually need to review what
// happened), truncated to 300 chars, and PII-redacted before storage --
// never the full raw prompt/response, and never at all for a routine
// ALLOW.

import { getOrgCollections, toObjectId } from "../orgs.js";
import { logOrgActivity } from "../org-activity-log.js";
import { createBusinessEvent } from "../businessEvents.js";
import { redactPII } from "./piiDetector.js";
import { EVENT_CATEGORIES, POLICY_VERSION } from "./policyTypes.js";

function safePreview(text) {
  if (!text) return null;
  const { text: redacted } = redactPII(String(text));
  return redacted.slice(0, 300);
}

/**
 * @param {Object} params
 * @param {string} params.orgId
 * @param {string} params.requestId
 * @param {string} params.actorEmail
 * @param {string} [params.sessionId]
 * @param {string} params.surface - which AI route/surface (e.g. "business-chat")
 * @param {string} [params.vertical]
 * @param {"PROMPT_INJECTION"|"PII"|"UNAUTHORIZED_ACCESS"|"EXCESSIVE_AGENCY"|"OUTPUT_SECURITY"|"MODEL_INTEGRITY"|"ABUSE"|"VALIDATION"|"OTHER"} params.category
 * @param {import("./policyEngine.js").SecurityDecision} params.decisionResult
 * @param {string} [params.modelId]
 * @param {string} [params.rawInput] - never stored raw; only a redacted, truncated preview is persisted, and only for non-ALLOW decisions
 * @param {string} [params.rawOutput]
 */
export async function recordAiSecurityEvent({
  orgId, requestId, actorEmail, sessionId, surface, vertical,
  category, decisionResult, modelId, rawInput, rawOutput,
}) {
  if (!EVENT_CATEGORIES.includes(category)) category = "OTHER";
  const { aiSecurityChecks } = await getOrgCollections();
  const now = new Date().toISOString();
  const isConsequential = decisionResult.decision !== "ALLOW";

  const doc = {
    orgId: toObjectId(orgId),
    requestId, timestamp: now,
    actorEmail: actorEmail || null, sessionId: sessionId || null,
    surface, vertical: vertical || null,
    category,
    severity: decisionResult.severity,
    decision: decisionResult.decision,
    reasons: decisionResult.reasons,
    controlsTriggered: decisionResult.controlsTriggered,
    policyId: decisionResult.policyId || null,
    policyVersion: decisionResult.policyVersion || POLICY_VERSION,
    modelId: modelId || null,
    modelVersion: modelId || null,
    inputPreview: isConsequential ? safePreview(rawInput) : null,
    outputPreview: isConsequential ? safePreview(rawOutput) : null,
    deletedAt: null,
    createdAt: now,
  };

  const { insertedId } = await aiSecurityChecks.insertOne(doc);

  // Best-effort beyond the primary record above -- matches this
  // codebase's own established "non-fatal" discipline (see s3-compat/
  // store.js's backupEngine registration calls) for secondary evidence
  // writes that must never make the actual security decision (already
  // returned to the caller before this function runs) fail or hang.
  logOrgActivity({
    orgId, recordType: "AI_SECURITY_CHECK", recordId: insertedId, actorEmail: actorEmail || "system",
    action: `AI_${decisionResult.decision}`, previousState: null, newState: decisionResult.decision,
    metadata: { category, severity: decisionResult.severity, surface, requestId, controlsTriggered: decisionResult.controlsTriggered },
  }).catch((err) => console.error("recordAiSecurityEvent: logOrgActivity failed (non-fatal):", err.message));

  if (isConsequential) {
    // Recording evidence about a security decision must not depend on
    // the ACTING user's own org role -- the person most likely to
    // trigger a BLOCK (a non-manager attempting something they
    // shouldn't) is exactly the person whose event still needs a real
    // Evidence Graph node. AI_SECURITY_CHECK's hasDepartment:false path
    // in businessEvents.js falls back to canManageOrg(membership), so a
    // regular member's own membership would silently fail this check --
    // same synthetic-elevated-membership pattern used for the Sovereign
    // NAS SOW's appliance registration (system bookkeeping, not the
    // acting user's own permission).
    createBusinessEvent({
      orgId, subjectType: "AI_SECURITY_CHECK", subjectId: insertedId.toString(),
      membership: { role: "owner" }, actorEmail: actorEmail || "system", relationships: [],
    }).then((result) => {
      if (result?.error) console.error("recordAiSecurityEvent: createBusinessEvent returned an error (non-fatal):", result.error);
    }).catch((err) => console.error("recordAiSecurityEvent: createBusinessEvent failed (non-fatal):", err.message));
  }

  return { eventId: insertedId.toString() };
}

export async function listAiSecurityEvents({ orgId, limit = 100, category, decision }) {
  const { aiSecurityChecks } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId), deletedAt: null };
  if (category) query.category = category;
  if (decision) query.decision = decision;
  return aiSecurityChecks.find(query).sort({ createdAt: -1 }).limit(Math.min(limit, 500)).toArray();
}

export async function getAiSecurityEvent({ orgId, eventId }) {
  const { aiSecurityChecks } = await getOrgCollections();
  return aiSecurityChecks.findOne({ _id: toObjectId(eventId), orgId: toObjectId(orgId) });
}
