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
import { retrieveContext, formatAttribution } from "./rag/retrieve.js";

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

/** Static/conceptual "how does X work" lookups (policy, confirmation
 *  threshold, reputation scoring) — RAG-backed, clearly separate from the
 *  three tools above which all read live per-request data. Never returns
 *  threat/reputation/event data itself; that's what the other three tools
 *  are for. See rag/sources/securitySources.js for exactly what's indexed
 *  here — static documentation only, nothing dynamic ever enters this
 *  index. */
async function searchSecurityDocumentation(args) {
  const query = args?.query;
  if (!query) return { error: "query is required." };
  const { chunks, hasResults } = await retrieveContext({ query, domain: "security" });
  if (!hasResults) {
    return { found: false, message: "No indexed Inaya security documentation matches this question." };
  }
  return {
    found: true,
    excerpts: chunks.map((c) => ({ title: c.title, section: c.section, text: c.text })),
    attribution: formatAttribution(chunks).trim(),
  };
}

// ============================================================
// Gemini function-calling declarations + dispatcher
// ============================================================
export const SECURITY_TOOL_DECLARATIONS = [
  {
    name: "search_security_documentation",
    description: "Search Inaya's STATIC security documentation for conceptual/how-it-works questions (e.g. \"how does node reputation work\", \"what does confirmed mean\", \"what is the current policy mode\"). Do NOT use this for questions about a specific destination's current status or the caller's own events — use explain_threat / get_threat_reputation_detail / get_recent_security_events for those instead.",
    parameters: {
      type: Type.OBJECT,
      properties: { query: { type: Type.STRING, description: "The conceptual question to search documentation for." } },
      required: ["query"],
    },
  },
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
  search_security_documentation: (args) => searchSecurityDocumentation(args),
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
  return `You are the Inaya AI Security Assistant, part of the Inaya Network Security Layer. You explain security events, threat verdicts, and how the Security Layer works using ONLY the data returned by the provided tools — never guess, never invent evidence, never speculate about a destination you have no tool data for.

You have two categories of tool, and must keep their answers visibly distinct:
- DOCUMENTED information: search_security_documentation — for "how does X work" / conceptual questions. When you use it, make clear you're describing Inaya's documented policy/design (e.g. "Per Inaya's security documentation...").
- CURRENT network/security data: get_recent_security_events, explain_threat, get_threat_reputation_detail — for "what's happening right now" questions about a specific destination or the caller's own history. When you use these, make clear it's live data (e.g. "Based on current network data...").
Never blend the two into one unlabeled claim — a documented threshold and a live confidence score are different kinds of fact and the user should always be able to tell which one you're giving them.

If search_security_documentation returns found:false, or explain_threat/get_threat_reputation_detail returns known:false, say plainly that Inaya has no recorded information for that — do not describe a destination as safe or unsafe either way, and do not fill the gap with general knowledge about cybersecurity.

Ground every live-data answer in the tool's actual numbers: category, status (unverified/confirmed/disputed/cleared), confidence percentage (confidenceBps / 100), and independent reporter count. Never state or imply a specific reporting node's identity/address — reputation is reported only in aggregate.

Keep answers concise and plain-language, not raw JSON. You cannot change settings, block, or unblock anything yourself — if asked to take an action, tell the user to use the Security screen's controls.`;
}
