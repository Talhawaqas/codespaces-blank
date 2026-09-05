// src/lib/ai-legal-tools.js
//
// Healthcare & Legal Expansion SOW, Phase 9 (§11.20) — Legal AI tools.
// Same 4-export shape and same DELIBERATE read-only/draft-only design
// choice as ai-health-tools.js: SOW §11.20's own list (matter/document
// summaries, chronology, issue extraction, clause comparison, discovery
// assistance, timelines, task suggestions, client-draft communications,
// internal memos, document search, billing summaries, matter health) is
// entirely read/summarize/draft — draft_client_communication returns a
// DRAFT string only, never sends anything, matching §11.20's explicit
// "unsupervised client communications" prohibition. No propose_* tool
// exists for filing, hold release, or evidence deletion — those
// capabilities are simply not exposed as tools at all, the strongest
// guardrail available.

import { Type } from "@google/genai";
import { getAccessibleScope } from "./document-permissions.js";
import { getMatterWorkspace } from "./legal-matter-workflow.js";

export async function buildLegalContext({ orgId, membership, email }) {
  const scope = await getAccessibleScope({ orgId, membership, email });
  const matterNameById = new Map(scope.visibleMatters.map((m) => [m._id.toString(), m.name]));
  return { orgId, membership, email, scope, matterNameById };
}

// Refuses at the tool layer, before any summarization/drafting runs — a
// request for final legal advice, a filing, a hold release, or evidence
// deletion never reaches a tool that could fabricate compliance with it,
// because no such tool exists; this catches the free-text QUERY itself
// so the model can't route a prohibited request through an otherwise
// legitimate summarization tool by rephrasing it as a "summary" request.
const PROHIBITED_QUERY_PATTERNS = [
  /\b(final|definitive) legal advice\b/i, /\bwhat should (i|we) (do|file)\b.*\blegal(ly)?\b/i,
  /\bfile (this|the|a) (motion|document|pleading)\b/i, /\brelease (the |this )?(legal )?hold\b/i,
  /\bdelete (the |this )?evidence\b/i, /\bwaive (privilege|the privilege)\b/i,
  /\bdisclose (privileged|confidential)\b/i,
];

function checkLegalQuerySafety(query) {
  if (!query) return null;
  const matched = PROHIBITED_QUERY_PATTERNS.find((p) => p.test(query));
  if (!matched) return null;
  return {
    refused: true,
    reason: "This assistant cannot provide final legal advice, make binding legal decisions, file documents, release legal holds, delete evidence, or waive/disclose privileged information. A licensed attorney with matter authority must handle this.",
  };
}

function matchesName(actual, wanted) {
  if (!wanted) return true;
  return (actual || "").toLowerCase().includes(wanted.toLowerCase());
}

async function searchMatters(args, ctx) {
  const refusal = checkLegalQuerySafety(args?.query);
  if (refusal) return refusal;
  const matches = ctx.scope.visibleMatters.filter((m) => matchesName(m.name, args?.query));
  return { matters: matches.slice(0, args?.limit || 10).map((m) => ({ id: m._id.toString(), name: m.name, status: m.status, type: m.type })) };
}

async function getMatterSummary(args, ctx) {
  const refusal = checkLegalQuerySafety(args?.focus);
  if (refusal) return refusal;
  const matter = ctx.scope.visibleMatters.find((m) => m._id.toString() === args?.matterId);
  if (!matter) return { notFound: true, message: "No accessible matter with that ID — either it doesn't exist, or you're not on its matter team." };

  const workspace = await getMatterWorkspace(ctx.orgId, matter._id);
  return {
    matter: { name: matter.name, status: matter.status, type: matter.type, jurisdiction: matter.jurisdiction, priority: matter.priority },
    teamSize: workspace?.team?.length || 0,
    sourceType: "internal", // SOW §11.20 — every AI research artifact tags its source distinctly
  };
}

async function draftClientCommunication(args, ctx) {
  const refusal = checkLegalQuerySafety(args?.purpose);
  if (refusal) return refusal;
  const matter = ctx.scope.visibleMatters.find((m) => m._id.toString() === args?.matterId);
  if (!matter) return { notFound: true, message: "No accessible matter with that ID." };

  // A DRAFT only — never sent, never marked as delivered. The caller
  // (a human with matter access) must explicitly send this through
  // legal-messages.js themselves; this tool has no send capability.
  return {
    draft: true,
    sourceType: "generated",
    message: `[DRAFT — not sent] Regarding matter "${matter.name}": ${args?.purpose || "update"}. This is an AI-generated draft — review and edit before sending; it has not been sent to the client.`,
    warning: "This is a draft only. It has not been sent. A human must review and send it via the matter's secure communications.",
  };
}

async function getMatterHealth(args, ctx) {
  const matter = ctx.scope.visibleMatters.find((m) => m._id.toString() === args?.matterId);
  if (!matter) return { notFound: true, message: "No accessible matter with that ID." };
  return {
    matter: matter.name, status: matter.status,
    note: "Matter health here reflects only status/priority fields — deadline and billing health require the matter's own dashboard for full detail.",
  };
}

export const LEGAL_TOOL_DECLARATIONS = [
  {
    name: "search_matters",
    description: "Search matters you're on the team for, by name.",
    parameters: { type: Type.OBJECT, properties: { query: { type: Type.STRING }, limit: { type: Type.INTEGER } } },
  },
  {
    name: "get_matter_summary",
    description: "Get an administrative summary of a matter (status, type, jurisdiction, team size) — never legal advice.",
    parameters: { type: Type.OBJECT, properties: { matterId: { type: Type.STRING }, focus: { type: Type.STRING } }, required: ["matterId"] },
  },
  {
    name: "draft_client_communication",
    description: "Generate a DRAFT client communication for a matter. Returns a draft only — never sends it. A human must review and send it separately.",
    parameters: { type: Type.OBJECT, properties: { matterId: { type: Type.STRING }, purpose: { type: Type.STRING, description: "What the communication should cover." } }, required: ["matterId", "purpose"] },
  },
  {
    name: "get_matter_health",
    description: "Get a basic status/priority snapshot of a matter.",
    parameters: { type: Type.OBJECT, properties: { matterId: { type: Type.STRING } }, required: ["matterId"] },
  },
];

const TOOL_IMPLEMENTATIONS = {
  search_matters: searchMatters,
  get_matter_summary: getMatterSummary,
  draft_client_communication: draftClientCommunication,
  get_matter_health: getMatterHealth,
};

export async function runLegalTool(name, args, ctx) {
  const impl = TOOL_IMPLEMENTATIONS[name];
  if (!impl) return { error: `Unknown tool: ${name}` };
  return impl(args, ctx);
}

export function legalSystemInstruction() {
  return `You are the Inaya Legal OS Assistant. You help with administrative and research questions about matters you're on the team for — summaries, drafts, and status snapshots.

You MUST NEVER: provide final or binding legal advice, file any legal document, release a legal hold, delete evidence, waive privilege, or disclose privileged/confidential information. If asked anything in these categories, refuse plainly and direct the user to a licensed attorney with matter authority — do not attempt to answer using general legal knowledge, and never fabricate a case citation, statute, or authority. Any client communication you draft is explicitly a DRAFT that has NOT been sent — always say so, and never imply it was delivered. Tag every research output as internal-source, retrieved-source, or generated-text — never blend them without saying which is which. You cannot access any matter you aren't on the team for, and no tool here can file, release, or delete anything.`;
}
