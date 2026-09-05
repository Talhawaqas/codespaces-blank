// src/lib/policy-engine.js
//
// Healthcare & Legal Expansion SOW, Phase 1 (§14) — a reusable policy
// abstraction, backed by the industry_policies collection. Deliberately a
// pure, synchronous, table-driven evaluator (no LLM, no fuzzy matching) so
// it's genuinely testable and auditable, matching business-brief.js's
// "highlights never fail" discipline elsewhere in this codebase. This does
// NOT replace document-permissions.js/classification.js's access
// resolution — those answer "can this identity see this record at all."
// This answers a narrower, action-specific question: "given that they can
// see it, is THIS action (download/export/share/AI-submission/bulk
// retrieval) allowed right now" — SOW §4.6's DLP-style policy gate.
//
// A policy rule is a plain object: { subject, role, resource, action,
// classification, purpose, time, location, approval, retention,
// externalSharingState, result }. Any field left undefined on a rule
// means "matches anything" for that field — a rule only needs to specify
// the fields it actually constrains.

import { getOrgCollections, toObjectId } from "./orgs.js";

export const POLICY_RESULTS = ["allow", "warn", "require_approval", "block"];

function fieldMatches(ruleValue, contextValue) {
  if (ruleValue === undefined || ruleValue === null) return true;
  if (Array.isArray(ruleValue)) return ruleValue.includes(contextValue);
  return ruleValue === contextValue;
}

/** Pure function — no I/O. `rules` is the caller's already-fetched list of
 *  this org's industry_policies rows for the relevant `action`. Evaluates
 *  in array order, first full match wins (mirrors firewall/ACL-rule
 *  semantics — most specific rule should be listed first by whoever
 *  authored the policy). No matching rule at all defaults to "allow" for
 *  ordinary actions and "require_approval" for the four SOW §4.6 high-risk
 *  actions (download/export/external_share/bulk_retrieval/ai_submission),
 *  so a misconfigured org fails toward caution, not toward silent allow. */
export function evaluatePolicy({ subject, role, resource, action, classification, purpose, time, location, approval, retention, externalSharingState }, rules) {
  const context = { subject, role, resource, action, classification, purpose, time, location, approval, retention, externalSharingState };

  for (const rule of rules || []) {
    const matched = ["subject", "role", "resource", "action", "classification", "purpose", "time", "location", "approval", "retention", "externalSharingState"]
      .every((field) => fieldMatches(rule[field], context[field]));
    if (matched) return { result: rule.result, matchedRule: rule };
  }

  const HIGH_RISK_ACTIONS = ["download", "export", "external_share", "bulk_retrieval", "ai_submission"];
  const defaultResult = HIGH_RISK_ACTIONS.includes(action) ? "require_approval" : "allow";
  return { result: defaultResult, matchedRule: null };
}

/** Fetches this org's rules for a given action and evaluates in one call —
 *  the convenience path most API routes will actually use. */
export async function checkPolicy(orgId, context) {
  const { industryPolicies } = await getOrgCollections();
  const rules = await industryPolicies
    .find({ orgId: toObjectId(orgId), key: { $regex: `^action:${context.action}` } })
    .sort({ priority: 1 })
    .toArray();
  return evaluatePolicy(context, rules);
}

/** Org admins configure rules through this — key is namespaced
 *  `action:<action>:<ruleName>` so checkPolicy's prefix query above stays
 *  a simple, indexed $regex rather than needing a second field. */
export async function upsertPolicyRule(orgId, ruleName, action, rule) {
  const { industryPolicies } = await getOrgCollections();
  const key = `action:${action}:${ruleName}`;
  return industryPolicies.findOneAndUpdate(
    { orgId: toObjectId(orgId), key },
    { $set: { orgId: toObjectId(orgId), key, ...rule, action, updatedAt: new Date().toISOString() }, $setOnInsert: { createdAt: new Date().toISOString() } },
    { upsert: true, returnDocument: "after" }
  );
}
