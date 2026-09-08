// src/lib/government-procurement.js
//
// Government & Public Sector Sovereign OS SOW, Phase 2 (§D "Procurement",
// open question (b) from the Phase 1 plan: "whether public-sector-specific
// procurement rules — competitive-bid thresholds, etc. — are wanted").
//
// Deliberately a small, ADDITIVE, informational helper — NOT a change to
// the existing purchase-request-workflow.js/purchase-order-workflow.js
// state machines or their API routes. Real competitive-bid thresholds vary
// by jurisdiction and agency and aren't something this codebase can
// correctly hard-code as a universal rule; forking or gating the shared,
// already-shipped procurement engine on an invented number would risk
// that already-working code for every other vertical for a rule this
// pass has no authoritative source for. What ships instead: a pure,
// informational flag a Government-vertical org's procurement UI/AI can
// surface ("this request is above the configured competitive-bid
// threshold — consider a competitive process") without blocking anything
// -- an org can configure its own real threshold via the standard
// industry-config.js org-profile fields (see DEFAULT_PROFILE's existing
// extensible shape) once it has one.

const DEFAULT_COMPETITIVE_BID_THRESHOLD = 25000; // a common small-jurisdiction default; always overridable per org, never treated as a legal requirement

/** Pure, no I/O. `thresholdOverride` should come from the org's own
 *  configured policy (e.g. a future industry-config.js field) when one
 *  exists — this function never claims to know the real legal threshold
 *  for any specific jurisdiction. */
export function flagCompetitiveBidRequirement(amount, thresholdOverride) {
  const threshold = typeof thresholdOverride === "number" ? thresholdOverride : DEFAULT_COMPETITIVE_BID_THRESHOLD;
  const numericAmount = Number(amount) || 0;
  return {
    aboveThreshold: numericAmount >= threshold,
    threshold,
    note: "Informational only — not a legal determination. Configure your organization's real competitive-bid threshold and procurement rules per your jurisdiction's requirements.",
  };
}

export { DEFAULT_COMPETITIVE_BID_THRESHOLD };
