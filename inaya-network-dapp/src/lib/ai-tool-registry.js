// src/lib/ai-tool-registry.js
//
// Financial Services & Regulated Enterprise SOW, Phase 6 (§91) — AI Tool
// Registry. Every tool the Financial Services/Private Capital/Regulated
// Enterprise copilots expose must declare: name, domain, permissions,
// risk, read/write, required role, required scope, approval requirement,
// audit behavior, rate limit, and idempotency behavior.
//
// This is a real, checked artifact, not a decorative one:
// test/ai-tool-registry.test.mjs asserts every tool name actually
// declared in compliance/investment/private-capital/audit/regulatory's
// own *_TOOL_DECLARATIONS has a matching entry here, and fails the build
// if a new tool is added to one of those files without a registry entry —
// the same "drift can't silently happen" discipline as
// vertical-lock-wiring.test.mjs for API routes.
//
// Scoped to the tool files this SOW's phases introduced (compliance,
// investment, private-capital, audit, regulatory). Business/Security/
// Health/Legal predate this SOW and are out of scope for this pass.

export const AI_TOOL_REGISTRY = [
  // ---- Compliance Copilot (Phase 4) ----
  { name: "search_controls", domain: "compliance", permissions: ["read:compliance_controls"], risk: "LOW", readWrite: "read", requiredRole: "org member", requiredScope: "org", approvalRequirement: "none", auditBehavior: "not logged (read-only)", rateLimit: "shared chat rate limit", idempotencyBehavior: "n/a — read-only" },
  { name: "get_control_detail", domain: "compliance", permissions: ["read:compliance_controls", "read:compliance_control_tests"], risk: "LOW", readWrite: "read", requiredRole: "org member", requiredScope: "org", approvalRequirement: "none", auditBehavior: "not logged (read-only)", rateLimit: "shared chat rate limit", idempotencyBehavior: "n/a — read-only" },
  { name: "list_missing_evidence", domain: "compliance", permissions: ["read:compliance_controls", "read:compliance_evidence"], risk: "LOW", readWrite: "read", requiredRole: "org member", requiredScope: "org", approvalRequirement: "none", auditBehavior: "not logged (read-only)", rateLimit: "shared chat rate limit", idempotencyBehavior: "n/a — read-only" },
  { name: "list_expiring_policies", domain: "compliance", permissions: ["read:compliance_policies"], risk: "LOW", readWrite: "read", requiredRole: "org member", requiredScope: "org", approvalRequirement: "none", auditBehavior: "not logged (read-only)", rateLimit: "shared chat rate limit", idempotencyBehavior: "n/a — read-only" },
  { name: "summarize_open_findings", domain: "compliance", permissions: ["read:compliance_findings"], risk: "LOW", readWrite: "read", requiredRole: "org member", requiredScope: "org", approvalRequirement: "none", auditBehavior: "not logged (read-only)", rateLimit: "shared chat rate limit", idempotencyBehavior: "n/a — read-only" },
  { name: "get_compliance_health_summary", domain: "compliance", permissions: ["read:compliance_controls", "read:compliance_evidence", "read:compliance_findings"], risk: "LOW", readWrite: "read", requiredRole: "org member", requiredScope: "org", approvalRequirement: "none", auditBehavior: "not logged (read-only)", rateLimit: "shared chat rate limit", idempotencyBehavior: "n/a — read-only" },
  { name: "list_upcoming_reviews", domain: "compliance", permissions: ["read:compliance_controls"], risk: "LOW", readWrite: "read", requiredRole: "org member", requiredScope: "org", approvalRequirement: "none", auditBehavior: "not logged (read-only)", rateLimit: "shared chat rate limit", idempotencyBehavior: "n/a — read-only" },

  // ---- Investment Copilot (Phase 2) ----
  { name: "summarize_thesis", domain: "investment", permissions: ["read:investment_theses"], risk: "LOW", readWrite: "read", requiredRole: "org member", requiredScope: "org", approvalRequirement: "none", auditBehavior: "not logged (read-only)", rateLimit: "shared chat rate limit", idempotencyBehavior: "n/a — read-only" },
  { name: "compare_thesis_versions", domain: "investment", permissions: ["read:investment_theses"], risk: "LOW", readWrite: "read", requiredRole: "org member", requiredScope: "org", approvalRequirement: "none", auditBehavior: "not logged (read-only)", rateLimit: "shared chat rate limit", idempotencyBehavior: "n/a — read-only" },
  { name: "what_changed_since_last_ic", domain: "investment", permissions: ["read:ic_cases", "read:ic_decisions"], risk: "LOW", readWrite: "read", requiredRole: "org member", requiredScope: "org", approvalRequirement: "none", auditBehavior: "not logged (read-only)", rateLimit: "shared chat rate limit", idempotencyBehavior: "n/a — read-only" },
  { name: "list_supporting_documents", domain: "investment", permissions: ["read:investment_research"], risk: "LOW", readWrite: "read", requiredRole: "org member", requiredScope: "org", approvalRequirement: "none", auditBehavior: "not logged (read-only)", rateLimit: "shared chat rate limit", idempotencyBehavior: "n/a — read-only" },
  { name: "check_exposure_limits", domain: "investment", permissions: ["read:exposure_thresholds", "read:positions"], risk: "LOW", readWrite: "read", requiredRole: "org member", requiredScope: "org", approvalRequirement: "none", auditBehavior: "not logged (read-only)", rateLimit: "shared chat rate limit", idempotencyBehavior: "n/a — read-only" },

  // ---- Private Capital Copilot (Phase 3) ----
  { name: "list_open_diligence_gaps", domain: "private_capital", permissions: ["read:diligence_requests"], risk: "LOW", readWrite: "read", requiredRole: "org member", requiredScope: "org", approvalRequirement: "none", auditBehavior: "not logged (read-only)", rateLimit: "shared chat rate limit", idempotencyBehavior: "n/a — read-only" },
  { name: "summarize_deal_scorecards", domain: "private_capital", permissions: ["read:deal_scorecards"], risk: "LOW", readWrite: "read", requiredRole: "org member", requiredScope: "org", approvalRequirement: "none", auditBehavior: "not logged (read-only)", rateLimit: "shared chat rate limit", idempotencyBehavior: "n/a — read-only" },
  { name: "compare_term_sheet_versions", domain: "private_capital", permissions: ["read:term_sheets"], risk: "LOW", readWrite: "read", requiredRole: "org member", requiredScope: "org", approvalRequirement: "none", auditBehavior: "not logged (read-only)", rateLimit: "shared chat rate limit", idempotencyBehavior: "n/a — read-only" },
  { name: "list_pipeline_deals", domain: "private_capital", permissions: ["read:private_capital_deals"], risk: "LOW", readWrite: "read", requiredRole: "org member", requiredScope: "org", approvalRequirement: "none", auditBehavior: "not logged (read-only)", rateLimit: "shared chat rate limit", idempotencyBehavior: "n/a — read-only" },
  { name: "get_portfolio_company_monitoring", domain: "private_capital", permissions: ["read:portfolio_companies", "read:portfolio_kpi_values"], risk: "LOW", readWrite: "read", requiredRole: "org member", requiredScope: "org", approvalRequirement: "none", auditBehavior: "not logged (read-only)", rateLimit: "shared chat rate limit", idempotencyBehavior: "n/a — read-only" },

  // ---- Audit Copilot (Phase 6, §198 — read-only by default) ----
  { name: "locate_evidence", domain: "audit", permissions: ["read:compliance_evidence"], risk: "LOW", readWrite: "read", requiredRole: "org member", requiredScope: "org", approvalRequirement: "none", auditBehavior: "not logged (read-only)", rateLimit: "shared chat rate limit", idempotencyBehavior: "n/a — read-only" },
  { name: "trace_control", domain: "audit", permissions: ["read:compliance_controls", "read:compliance_evidence"], risk: "LOW", readWrite: "read", requiredRole: "org member", requiredScope: "org", approvalRequirement: "none", auditBehavior: "not logged (read-only)", rateLimit: "shared chat rate limit", idempotencyBehavior: "n/a — read-only" },
  { name: "review_findings", domain: "audit", permissions: ["read:compliance_findings"], risk: "LOW", readWrite: "read", requiredRole: "org member", requiredScope: "org", approvalRequirement: "none", auditBehavior: "not logged (read-only)", rateLimit: "shared chat rate limit", idempotencyBehavior: "n/a — read-only" },
  { name: "generate_evidence_package", domain: "audit", permissions: ["read:compliance_evidence", "read:compliance_findings"], risk: "LOW", readWrite: "read", requiredRole: "org member", requiredScope: "org", approvalRequirement: "none", auditBehavior: "not logged (read-only)", rateLimit: "shared chat rate limit", idempotencyBehavior: "n/a — read-only" },
  { name: "identify_gaps", domain: "audit", permissions: ["read:compliance_controls", "read:compliance_evidence", "read:compliance_findings"], risk: "LOW", readWrite: "read", requiredRole: "org member", requiredScope: "org", approvalRequirement: "none", auditBehavior: "not logged (read-only)", rateLimit: "shared chat rate limit", idempotencyBehavior: "n/a — read-only" },
  { name: "list_audit_plans", domain: "audit", permissions: ["read:internal_audit_plans"], risk: "LOW", readWrite: "read", requiredRole: "org member", requiredScope: "org", approvalRequirement: "none", auditBehavior: "not logged (read-only)", rateLimit: "shared chat rate limit", idempotencyBehavior: "n/a — read-only" },

  // ---- Regulatory Copilot (Phase 6, §199 — human review required) ----
  { name: "get_enabled_frameworks_and_coverage", domain: "regulatory", permissions: ["read:compliance_org_frameworks", "read:compliance_controls"], risk: "LOW", readWrite: "read", requiredRole: "org member", requiredScope: "org", approvalRequirement: "none", auditBehavior: "not logged (read-only)", rateLimit: "shared chat rate limit", idempotencyBehavior: "n/a — read-only" },
  { name: "check_applicability", domain: "regulatory", permissions: [], risk: "LOW", readWrite: "read", requiredRole: "org member", requiredScope: "org", approvalRequirement: "none", auditBehavior: "not logged (read-only)", rateLimit: "shared chat rate limit", idempotencyBehavior: "n/a — read-only" },
  { name: "list_control_mapping_gaps", domain: "regulatory", permissions: ["read:compliance_controls"], risk: "LOW", readWrite: "read", requiredRole: "org member", requiredScope: "org", approvalRequirement: "none", auditBehavior: "not logged (read-only)", rateLimit: "shared chat rate limit", idempotencyBehavior: "n/a — read-only" },
  { name: "list_evidence_gaps", domain: "regulatory", permissions: ["read:compliance_controls", "read:compliance_evidence"], risk: "LOW", readWrite: "read", requiredRole: "org member", requiredScope: "org", approvalRequirement: "none", auditBehavior: "not logged (read-only)", rateLimit: "shared chat rate limit", idempotencyBehavior: "n/a — read-only" },
  { name: "list_policies_needing_change", domain: "regulatory", permissions: ["read:compliance_policies"], risk: "LOW", readWrite: "read", requiredRole: "org member", requiredScope: "org", approvalRequirement: "none", auditBehavior: "not logged (read-only)", rateLimit: "shared chat rate limit", idempotencyBehavior: "n/a — read-only" },
  {
    name: "propose_policy_amendment", domain: "regulatory", permissions: ["write:compliance_policies (via guarded action only)"],
    risk: "HIGH", readWrite: "write", requiredRole: "compliance staff (to propose); compliance manager or org owner/admin (to approve)",
    requiredScope: "org", approvalRequirement: "human approval required — routed through ai-action-requests.js's proposeAiAction/reviewAiAction; never executes directly",
    auditBehavior: "logged: org_activity (AI_ACTION_PROPOSED/APPROVED/EXECUTED) + audit hash chain",
    rateLimit: "shared chat rate limit", idempotencyBehavior: "idempotent within a 1-hour window (sha256 of org+tool+target+args+hour-bucket)",
  },
];

export function getToolRegistryEntry(name) {
  return AI_TOOL_REGISTRY.find((t) => t.name === name) || null;
}

export function listToolRegistryByDomain(domain) {
  return AI_TOOL_REGISTRY.filter((t) => t.domain === domain);
}

/** Returns the list of declared tool names (from a domain's own
 *  *_TOOL_DECLARATIONS array) that have NO matching registry entry — used
 *  by test/ai-tool-registry.test.mjs to catch drift. Empty array means
 *  full coverage. */
export function findUnregisteredTools(domain, declaredNames) {
  const registered = new Set(listToolRegistryByDomain(domain).map((t) => t.name));
  return declaredNames.filter((name) => !registered.has(name));
}
