// src/lib/aiSecurity/policyTypes.js
//
// Inaya AI Security Workflow 2026 SOW. Shared vocabulary for every module
// under src/lib/aiSecurity/ -- kept in one file so a decision/severity/
// category string is never spelled two different ways across the
// gateway, the policy engine, and the event recorder.

export const DECISIONS = ["ALLOW", "WARN", "REDACT", "BLOCK", "REQUIRE_APPROVAL"];

export const SEVERITIES = ["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"];

// SOW §47's AISecurityEvent.category, trimmed to the categories this pass
// actually detects for real -- MODEL_INTEGRITY/SUPPLY_CHAIN are tracked
// by modelRegistry.js's drift check, not by the gateway's per-request path.
export const EVENT_CATEGORIES = [
  "PROMPT_INJECTION",
  "PII",
  "UNAUTHORIZED_ACCESS",
  "EXCESSIVE_AGENCY",
  "OUTPUT_SECURITY",
  "MODEL_INTEGRITY",
  "ABUSE",
  "VALIDATION",
  "OTHER",
];

// Bumped whenever policyEngine.js's rule set changes in a way that could
// change a past decision's classification -- recorded on every decision
// so a later policy change never silently rewrites history's meaning.
export const POLICY_VERSION = "2026.1";

function severityRank(s) {
  return SEVERITIES.indexOf(s);
}

/** Combines two severities to the more severe one -- used when multiple
 *  detectors (injection + PII, say) fire on the same request. */
export function maxSeverity(a, b) {
  if (!a) return b;
  if (!b) return a;
  return severityRank(a) >= severityRank(b) ? a : b;
}

/** Combines two decisions to the more restrictive one, in the fixed order
 *  BLOCK > REQUIRE_APPROVAL > REDACT > WARN > ALLOW -- so a request that
 *  trips both a REDACT-worthy and a BLOCK-worthy rule always ends up
 *  BLOCKed, never silently downgraded by evaluation order. */
const DECISION_RANK = { ALLOW: 0, WARN: 1, REDACT: 2, REQUIRE_APPROVAL: 3, BLOCK: 4 };
export function mostRestrictiveDecision(a, b) {
  if (!a) return b;
  if (!b) return a;
  return DECISION_RANK[a] >= DECISION_RANK[b] ? a : b;
}
