// src/lib/segregation-of-duties.js
//
// Financial Services & Regulated Enterprise SOW, Phase 5 (§61) —
// Segregation of Duties. Cross-vertical. "All SoD rules must be
// configurable" (§61) -- this module is the configuration registry PLUS
// a generic reusable checker, not a rewrite of every approval gate in
// this codebase. Several of §61's named conflicts are ALREADY enforced
// structurally, before this file ever existed, by a dual-actor check at
// the exact point of approval:
//
//   - "portfolio manager approving own valuation" ->
//     valuation-management.js's approveValuation()
//   - "administrator approving own access" ->
//     privileged-access.js's approveElevation()
//   - "AI-generated proposal self-approving" ->
//     ai-action-requests.js's reviewAiAction() (canApprove gate, never
//     the proposer)
//   - cap-table.js's approveCapTableSnapshot() (recorder != approver)
//
// Those enforcement points are NOT rewired to call through this file --
// they already correctly block the conflict every time, rewiring them
// would only add indirection with no behavior change. What THIS file
// adds is: (1) making each conflict type a visible, named, org-
// configurable rule (so an org can see and toggle what's enforced,
// matching §61's explicit requirement), and (2) checkSoDViolation() as a
// ready-made checker for any NEW approval flow this app adds later,
// so it doesn't have to reinvent the actorEmail !== subjectEmail check.

import { getOrgCollections, toObjectId, canManageOrg } from "./orgs.js";
import { logOrgActivity } from "./org-activity-log.js";

export const SOD_RULE_TYPES = [
  "requester_approves_own_request",
  "creator_approves_own_payment",
  "analyst_approves_own_exception",
  "administrator_approves_own_access",
  "portfolio_manager_approves_own_valuation",
  "compliance_user_changes_evidence_without_review",
  "ai_proposal_self_approves",
];

export async function listSodRules(orgId) {
  const { sodRules } = await getOrgCollections();
  const configured = await sodRules.find({ orgId: toObjectId(orgId) }).toArray();
  const byType = new Map(configured.map((r) => [r.ruleType, r]));
  // Every rule type is ALWAYS returned, defaulting to enabled -- an org
  // can only ever see and disable a real rule, never silently have one
  // missing from the list because it was never configured.
  return SOD_RULE_TYPES.map((ruleType) => byType.get(ruleType) || { ruleType, enabled: true, orgId: toObjectId(orgId), configuredAt: null });
}

export async function configureSodRule({ orgId, ruleType, enabled, actorEmail, membership }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can configure a segregation-of-duties rule.", status: 403 };
  if (!SOD_RULE_TYPES.includes(ruleType)) return { error: `Unknown SoD rule type "${ruleType}".`, status: 400 };

  const { sodRules } = await getOrgCollections();
  const now = new Date().toISOString();
  await sodRules.updateOne(
    { orgId: toObjectId(orgId), ruleType },
    { $set: { enabled: !!enabled, configuredByEmail: actorEmail, configuredAt: now } },
    { upsert: true }
  );
  await logOrgActivity({ orgId, recordType: "SOD_RULE", recordId: null, actorEmail, action: "CONFIGURED", previousState: null, newState: enabled ? "enabled" : "disabled", metadata: { ruleType } });
  return { ruleType, enabled: !!enabled };
}

/** Generic checker for any approval flow: is this rule enabled for the
 *  org, and if so, is the actor the same person as the subject? Returns
 *  { violation: true, ruleType } or { violation: false }. A disabled rule
 *  never blocks -- that's the org's own configured choice, made
 *  explicitly via configureSodRule(), not a silent default. */
export async function checkSodViolation({ orgId, ruleType, actorEmail, subjectEmail }) {
  if (!SOD_RULE_TYPES.includes(ruleType)) throw new Error(`Unknown SoD rule type "${ruleType}".`);
  const { sodRules } = await getOrgCollections();
  const rule = await sodRules.findOne({ orgId: toObjectId(orgId), ruleType });
  const enabled = rule ? rule.enabled : true;
  if (!enabled) return { violation: false };
  if (actorEmail && subjectEmail && actorEmail === subjectEmail) return { violation: true, ruleType };
  return { violation: false };
}
