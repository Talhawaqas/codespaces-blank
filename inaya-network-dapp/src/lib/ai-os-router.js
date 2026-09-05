// src/lib/ai-os-router.js
//
// Enterprise OS SOW, Phase 6 — the OS-Level AI Assistant. Confirmed
// before writing this: Business/Security/Learn assistants all follow the
// same real convention (build*Context/*_TOOL_DECLARATIONS/run*Tool/
// *SystemInstruction exports) and already share one library harness for
// their Groq fallback path (groqFallback.js's runGroqToolLoop) — but the
// Gemini-primary path is independently duplicated per route, and there
// is no top-level router dispatching across more than one domain's tools
// in a single conversation.
//
// This is a thin dispatch shim, deliberately — it does not reimplement
// any tool's actual logic, so a bug here can't change what
// runBusinessTool/runSecurityTool actually do. It only: (1) merges tool
// declarations with a name prefix so Gemini sees one combined tool list
// with no collisions, (2) routes a call by that prefix to the real
// existing dispatcher, (3) builds a combined context object once per
// request.
//
// TWO PAIRINGS, not four assistants merged into one: org scope merges
// Business + Security (an org member's natural OS-level question set);
// wallet scope merges a new search_docs tool (wrapping RAG's existing
// retrieveContext with domain:"docs", the exact same call
// /api/ai/chat itself makes) + Security (the dApp's natural pairing —
// Docs is already public/RAG-grounded, Security is already
// identity/wallet-scoped, neither fits a wallet-holder's questions about
// Business Workspace data, which doesn't apply outside an org). Learn is
// excluded from both v1 routers — it's wallet/video-scoped with no clear
// OS-level use case yet.

import { Type } from "@google/genai";
import { buildBusinessContext, runBusinessTool, BUSINESS_TOOL_DECLARATIONS, businessSystemInstruction } from "./ai-business-tools.js";
import { buildSecurityContext, runSecurityTool, SECURITY_TOOL_DECLARATIONS } from "./ai-security-tools.js";
import { buildHealthContext, runHealthTool, HEALTH_TOOL_DECLARATIONS, healthSystemInstruction } from "./ai-health-tools.js";
import { buildLegalContext, runLegalTool, LEGAL_TOOL_DECLARATIONS, legalSystemInstruction } from "./ai-legal-tools.js";
import { retrieveContext, formatAttribution } from "./rag/retrieve.js";

const DOCS_TOOL_DECLARATION = {
  name: "search_docs",
  description:
    "Search Inaya's general product documentation (features, FAQs, how things work) for conceptual questions. Not for security-specific questions — use security_search_security_documentation for those.",
  parameters: {
    type: Type.OBJECT,
    properties: { query: { type: Type.STRING, description: "The question to search documentation for." } },
    required: ["query"],
  },
};

/** Mirrors ai-security-tools.js's own searchSecurityDocumentation exactly
 *  (same retrieveContext call shape, same found:false/excerpts/attribution
 *  response shape) but domain:"docs" instead of domain:"security" — the
 *  same call /api/ai/chat itself makes for the Docs Assistant. */
async function searchDocs(args) {
  const query = args?.query;
  if (!query) return { error: "query is required." };
  const { chunks, hasResults } = await retrieveContext({ query, domain: "docs" });
  if (!hasResults) return { found: false, message: "No indexed Inaya documentation matches this question." };
  return {
    found: true,
    excerpts: chunks.map((c) => ({ title: c.title, section: c.section, text: c.text })),
    attribution: formatAttribution(chunks).trim(),
  };
}

function withPrefix(declarations, prefix) {
  return declarations.map((d) => ({ ...d, name: `${prefix}_${d.name}` }));
}

/** buildOsContext({scope:"org", orgId, membership, email}) or
 *  buildOsContext({scope:"wallet", walletAddress}). Returns the combined
 *  ctx object runOsTool() dispatches through — never passed to a tool
 *  function directly except via that dispatch, so each underlying
 *  tool set only ever sees the exact ctx shape it already expects. */
export async function buildOsContext(input) {
  if (input?.scope === "org") {
    const { orgId, membership, email } = input;
    const [businessCtx, securityCtx, healthCtx, legalCtx] = await Promise.all([
      buildBusinessContext({ orgId, membership, email }),
      buildSecurityContext({ identityId: email }).catch(() => null),
      // Healthcare & Legal Expansion SOW, Phase 5/9 — built unconditionally
      // for every org (cheap: it's just getAccessibleScope(), already
      // computed once per request for business/security too) rather than
      // gated on the org's configured vertical, since a member of a
      // "general" org with zero patients/matters just gets empty scope
      // arrays and every health_/legal_ tool naturally returns empty
      // results — no separate vertical-detection branch needed here.
      buildHealthContext({ orgId, membership, email }).catch(() => null),
      buildLegalContext({ orgId, membership, email }).catch(() => null),
    ]);
    return { scope: "org", businessCtx, securityCtx, healthCtx, legalCtx };
  }
  if (input?.scope === "wallet") {
    const { walletAddress } = input;
    const securityCtx = await buildSecurityContext({ identityId: walletAddress.toLowerCase() }).catch(() => null);
    return { scope: "wallet", securityCtx };
  }
  throw new Error('buildOsContext: scope must be "org" or "wallet".');
}

export function getOsToolDeclarations(scope) {
  if (scope === "org") {
    return [
      ...withPrefix(BUSINESS_TOOL_DECLARATIONS, "business"),
      ...withPrefix(SECURITY_TOOL_DECLARATIONS, "security"),
      ...withPrefix(HEALTH_TOOL_DECLARATIONS, "health"),
      ...withPrefix(LEGAL_TOOL_DECLARATIONS, "legal"),
    ];
  }
  if (scope === "wallet") {
    return [DOCS_TOOL_DECLARATION, ...withPrefix(SECURITY_TOOL_DECLARATIONS, "security")];
  }
  throw new Error('getOsToolDeclarations: scope must be "org" or "wallet".');
}

/** The dispatch shim itself — strips the domain prefix and calls straight
 *  into the real, unmodified runBusinessTool/runSecurityTool. */
export async function runOsTool(name, args, ctx) {
  if (name === "search_docs") return searchDocs(args);
  if (name.startsWith("business_") && ctx.businessCtx) return runBusinessTool(name.slice("business_".length), args, ctx.businessCtx);
  if (name.startsWith("security_") && ctx.securityCtx) return runSecurityTool(name.slice("security_".length), args, ctx.securityCtx);
  if (name.startsWith("health_") && ctx.healthCtx) return runHealthTool(name.slice("health_".length), args, ctx.healthCtx);
  if (name.startsWith("legal_") && ctx.legalCtx) return runLegalTool(name.slice("legal_".length), args, ctx.legalCtx);
  return { error: `Unknown or unavailable tool: ${name}` };
}

/** A genuinely new instruction, not a concatenation of business/security's
 *  own instructions — those reference their tools by UNPREFIXED name
 *  (e.g. "get_business_insights"), which would mismatch the actual
 *  prefixed tool names Gemini sees here ("business_get_business_insights")
 *  and confuse the model about what it can actually call. The behavioral
 *  constraints that matter (grounding-only, no speculation, respects real
 *  permissions) are restated in prose instead of copied verbatim. */
export function osSystemInstruction({ scope, orgName, role, isManager }) {
  if (scope === "org") {
    return businessSystemInstruction({ orgName, role, isManager }) +
      `\n\nYou ALSO have Security Layer tools (prefixed security_) for questions about threat status, security events, and how the Security Layer works — ground those answers only in what the tools return, exactly as strictly as your business tools, and never blend a documented policy claim with a live-data claim without saying which is which. If a question isn't covered by any available tool, say so rather than guessing.` +
      `\n\nYou ALSO have Health OS tools (prefixed health_) and Legal OS tools (prefixed legal_), for organizations running those verticals. ${healthSystemInstruction()}\n\n${legalSystemInstruction()}`;
  }
  return `You are the Inaya OS Assistant for a connected wallet — you help with general questions about how Inaya works (via search_docs, Inaya's indexed documentation) and this wallet's own security status (via the security_ tools: recent events, threat lookups, reputation detail).

Ground every answer in what a tool actually returns — never invent a feature, a threat verdict, or a security event that wasn't in a tool's response. If search_docs returns found:false, or a security_ tool returns known:false, say plainly that Inaya has no information on that rather than filling the gap with general knowledge. Keep documented-policy answers and live-data answers visibly distinct (e.g. "Per Inaya's documentation..." vs. "Based on current data..."). Never state or imply a specific reporting node's identity. You cannot take any action yourself (block/unblock, change settings) — point the user to the relevant screen's own controls for that.`;
}
