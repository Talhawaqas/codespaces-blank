// src/lib/ai-security-tools.js
//
// Tool implementations for the AI Security Assistant (POST /api/ai/security-chat).
//
// Direct structural copy of ai-business-tools.js's shape and guardrail
// philosophy: every tool reads only from already-verified security data
// (security_events scoped to the caller's own identityId, security_threats,
// security_reputation_cache) — the model can look things up, it can never
// invent or embellish a verdict (Security Layer SOW §14: "must only
// explain verified security data and must not invent evidence").
//
// No org/session system exists for anonymous device/wallet identities in
// this codebase (same trust model as activity.js/watcherPioneer.js) — the
// caller supplies its own identityId, and get_recent_security_events is
// scoped to exactly that identity, nothing broader.

import { Type } from "@google/genai";
import { getRecentSecurityEvents, getThreatByIndicator, getSecurityCollections, SECURITY_CATEGORIES } from "./security.js";

/** Computed once per chat request. */
export async function buildSecurityContext({ identityId }) {
  return { identityId };
}

async function getRecentEvents(args, ctx) {
  const limit = Math.min(Math.max(args?.limit || 10, 1), 30);
  const events = await getRecentSecurityEvents(ctx.identityId, limit);
  return {
    count: events.length,
    events: events.map((e) => ({
      eventType: e.eventType,
      destination: e.destination,
      decision: e.decision,
      reason: e.reason,
      category: e.category != null ? SECURITY_CATEGORIES[e.category] : null,
      confidenceBps: e.confidenceBps,
      createdAt: e.createdAt,
    })),
  };
}

async function explainThreat(args) {
  const indicator = args?.indicator;
  if (!indicator) return { error: "indicator is required." };
  const threat = await getThreatByIndicator(indicator);
  if (!threat.known) {
    return { known: false, message: "This destination has no recorded observations in the Inaya threat feed." };
  }
  return {
    known: true,
    indicator,
    category: SECURITY_CATEGORIES[threat.category] || "unknown",
    status: threat.statusLabel,
    confidenceBps: threat.confidenceBps,
    independentReporterCount: (threat.contributingNodes || []).length,
    firstSeen: threat.firstSeen,
    lastUpdated: threat.lastUpdated,
    onChainConfirmedAt: threat.onChainConfirmedAt,
    onChainTxHash: threat.onChainTxHash,
  };
}

/** Deliberately aggregate-only — individual reporting-node addresses are never surfaced to the
 *  chat, same "never reveal more than the UI already shows" discipline as the Business
 *  Assistant's get_document_access. */
async function getThreatReputationDetail(args) {
  const indicator = args?.indicator;
  if (!indicator) return { error: "indicator is required." };
  const threat = await getThreatByIndicator(indicator);
  if (!threat.known || !(threat.contributingNodes || []).length) {
    return { known: false, message: "No independent reporters recorded for this destination yet." };
  }

  const { reputationCache } = await getSecurityCollections();
  const repDocs = await reputationCache.find({ _id: { $in: threat.contributingNodes } }).toArray();
  const scores = repDocs.map((d) => d.scoreBps);
  const averageReporterReputationBps = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;

  return { independentReporterCount: threat.contributingNodes.length, averageReporterReputationBps };
}

// ============================================================
// Gemini function-calling declarations + dispatcher
// ============================================================
export const SECURITY_TOOL_DECLARATIONS = [
  {
    name: "get_recent_security_events",
    description: "Get the caller's own recent security events (blocks, warnings, allows, policy syncs).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        limit: { type: Type.INTEGER, description: "Max results, default 10, max 30." },
      },
    },
  },
  {
    name: "explain_threat",
    description: "Look up the verified verdict for a specific destination (domain or IP) — category, status, confidence, and how many independent Inaya nodes reported it.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        indicator: { type: Type.STRING, description: "The domain or IP address to look up." },
      },
      required: ["indicator"],
    },
  },
  {
    name: "get_threat_reputation_detail",
    description: "Get an aggregate reputation summary (count and average reporter trust score) for the independent nodes that reported a specific destination.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        indicator: { type: Type.STRING, description: "The domain or IP address to look up." },
      },
      required: ["indicator"],
    },
  },
];

const TOOL_IMPLEMENTATIONS = {
  get_recent_security_events: getRecentEvents,
  explain_threat: (args) => explainThreat(args),
  get_threat_reputation_detail: (args) => getThreatReputationDetail(args),
};

export async function runSecurityTool(name, args, ctx) {
  const impl = TOOL_IMPLEMENTATIONS[name];
  if (!impl) return { error: `Unknown tool: ${name}` };
  return impl(args, ctx);
}

export function securitySystemInstruction() {
  return `You are the Inaya AI Security Assistant, part of the Inaya Network Security Layer. You explain security events and threat verdicts using ONLY the data returned by the provided tools — never guess, never invent evidence, never speculate about a destination you have no tool data for.

If explain_threat or get_threat_reputation_detail returns known:false, say plainly that Inaya has no recorded observations for that destination yet — do not describe it as safe or unsafe either way.

Ground every answer in the tool's actual numbers: category, status (unverified/confirmed/disputed/cleared), confidence percentage (confidenceBps / 100), and independent reporter count. Never state or imply a specific reporting node's identity/address — reputation is reported only in aggregate.

Keep answers concise and plain-language, not raw JSON. You cannot change settings, block, or unblock anything yourself — if asked to take an action, tell the user to use the Security screen's controls.`;
}
