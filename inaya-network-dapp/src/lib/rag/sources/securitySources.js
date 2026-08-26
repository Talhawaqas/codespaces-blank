// src/lib/rag/sources/securitySources.js
//
// Source adapters for the "security" domain — STATIC knowledge only
// (policy explanations, how confirmation/reputation actually work).
// Deliberately does NOT ingest security_threats/security_reputation_cache/
// security_events — those are live, per-request data that must never go
// stale in a vector index; they stay exactly as they already are: live
// tool-calls in ai-security-tools.js, scoped by identityId, re-read fresh
// on every question. This is the concrete implementation of SOW §7's
// "must distinguish documented information from current network/security
// data" — the two are architecturally separate paths, not just labeled
// differently in the prompt.

import { chunkMarkdownByHeading } from "../chunking.js";
import { getSecurityCollections, CONFIRM_THRESHOLD_BPS, MIN_INDEPENDENT_REPORTERS, REPORT_LOOKBACK_MS } from "../../security.js";

// Authored once here (not extracted from anywhere else — no prior
// standalone "how the Security Layer works" doc existed in this repo per
// the research pass that preceded this plan) in plain language, derived
// directly from the real enforcement logic in src/lib/security.js so it
// can never drift into describing behavior the code doesn't actually
// have.
const SECURITY_LAYER_EXPLAINER = `
# Inaya Security Layer — How It Works

## What the Security Layer is
The Inaya Security Layer is a decentralized threat-intelligence system. Independent nodes submit signed observations about domains/IPs they believe are malicious (phishing, malware, scam, botnet command-and-control, spam). No single node's word is ever enough on its own — a destination only becomes CONFIRMED once independent corroboration and reputation thresholds are met.

## How a threat gets confirmed
A destination needs at least ${MIN_INDEPENDENT_REPORTERS} distinct reporting nodes within a ${Math.round(REPORT_LOOKBACK_MS / (24 * 60 * 60 * 1000))}-day lookback window before it can be confirmed at all. Confidence is computed from the average reputation of the reporting nodes, with a bonus for additional independent reporters beyond the minimum (capped). Once confidence crosses ${CONFIRM_THRESHOLD_BPS / 100}%, the threat's status flips from unverified to confirmed, and — best-effort, non-blocking — a confirmation is recorded on-chain via a relayer wallet.

## Threat statuses
- unverified — reported, but not yet enough independent corroboration to confirm.
- confirmed — crossed the confidence threshold; the on-chain record reflects this.
- disputed — conflicting signals.
- cleared — a previously flagged destination has been reviewed and cleared.

## Node reputation scoring
Every reporting node has a reputation score, expressed in basis points (0–10000, where 5000 is the neutral starting point for a node that's never been scored). The score weighs confirmed-correct reports positively and false positives negatively — a false positive is weighted three times as heavily as a correct report counts positively, a deliberate asymmetry so a node can't game its score by mixing in enough correct reports to offset bad ones. Individual node identities/addresses are never shown to end users — only aggregate reputation figures.

## What the Security Assistant can and can't do
The assistant can explain how the system works (this document) and, separately, look up real current data for a specific destination or the caller's own recent events — but it never blends the two into one unverified guess. It cannot change security settings, block or unblock anything, or take any action — only the Security screen's own controls do that.
`.trim();

async function policyAdapter() {
  const { policy } = await getSecurityCollections();
  const current = await policy.findOne({ _id: "current" });
  if (!current?.content) return [];

  const content = current.content;
  const lines = [
    `# Current Inaya Security Policy (version ${current.version || "unknown"})`,
    `## Mode`,
    `The active policy mode is: ${content.mode || "not set"}.`,
  ];
  if (content.categoryDefaults) {
    lines.push(`## Per-category default actions`);
    for (const [category, action] of Object.entries(content.categoryDefaults)) {
      lines.push(`- ${category}: ${action}`);
    }
  }

  return chunkMarkdownByHeading(lines.join("\n"), {
    sourceId: "security-policy", domain: "security", category: "policy",
    version: current.version ? String(current.version) : null, url: "/security",
  });
}

export const SECURITY_SOURCES = [
  {
    sourceId: "security-layer-explainer",
    domain: "security",
    adapter: () => chunkMarkdownByHeading(SECURITY_LAYER_EXPLAINER, {
      sourceId: "security-layer-explainer", domain: "security", category: "explainer", url: "/security",
    }),
  },
  {
    sourceId: "security-policy",
    domain: "security",
    adapter: policyAdapter,
  },
];
