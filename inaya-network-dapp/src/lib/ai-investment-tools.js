// src/lib/ai-investment-tools.js
//
// Financial Services & Regulated Enterprise SOW, Phase 2 (§25-26) —
// Research AI + AI Investment Memo Generation. "financial" vertical.
// Same 4-export shape as every other OS-level AI tool set.
//
// DELIBERATE DESIGN CHOICE, same reasoning as every prior AI tool file
// in this app: 100% READ-ONLY. §25 is explicit that the AI must "never
// invent a position, never invent a transaction, never invent a
// valuation, never invent a compliance approval" — there is no
// propose_* mutation tool here at all; a memo is drafted and returned to
// the caller for a human to actually create as a real research record
// via investment-research.js, never inserted directly.

import { Type } from "@google/genai";
import { getOrgCollections, toObjectId } from "./orgs.js";
import { listResearch } from "./investment-research.js";
import { listTheses } from "./investment-thesis.js";
import { listCases } from "./investment-committee.js";
import { getExposureDashboard } from "./portfolio-management.js";

export async function buildInvestmentContext({ orgId, membership, email }) {
  return { orgId, membership, email };
}

const PROHIBITED_QUERY_PATTERNS = [
  /\bguarantee(d)? (a |the )?(return|performance|profit)\b/i,
  /\bshould i (buy|sell|short|invest)\b/i,
  /\bwill (this|it|the stock|the position) (go up|go down|outperform)\b/i,
];

function checkInvestmentQuerySafety(query) {
  if (!query) return null;
  const matched = PROHIBITED_QUERY_PATTERNS.find((p) => p.test(query));
  if (!matched) return null;
  return { refused: true, reason: "This assistant cannot recommend a trade, guarantee a return, or predict where a position will go. It can only summarize research, theses, IC history, and exposure that already exist — the actual investment decision has to come from your investment team through the normal IC process." };
}

async function summarizeThesis(args, ctx) {
  const refusal = checkInvestmentQuerySafety(args?.focus);
  if (refusal) return refusal;
  const theses = await listTheses(ctx.orgId, { key: args?.key });
  const latest = theses[0];
  if (!latest) return { notFound: true, message: "No thesis found for that key." };
  return { thesis: { title: latest.title, version: latest.version, status: latest.status, upside: latest.upside, downside: latest.downside, keyRisks: latest.keyRisks, invalidationCriteria: latest.invalidationCriteria } };
}

async function compareThesisVersions(args, ctx) {
  const theses = await listTheses(ctx.orgId, { key: args?.key });
  if (theses.length < 2) return { notFound: true, message: "Fewer than two versions exist for that thesis key — nothing to compare." };
  const [current, previous] = theses;
  return {
    current: { version: current.version, valuation: current.valuation, upside: current.upside, downside: current.downside },
    previous: { version: previous.version, valuation: previous.valuation, upside: previous.upside, downside: previous.downside },
  };
}

async function whatChangedSinceLastIC(args, ctx) {
  const cases = await listCases(ctx.orgId, { fundId: args?.fundId });
  const recent = cases.slice(0, 5);
  return { recentCases: recent.map((c) => ({ id: c._id.toString(), opportunity: c.opportunity, status: c.status, updatedAt: c.updatedAt })) };
}

async function listSupportingDocuments(args, ctx) {
  const refusal = checkInvestmentQuerySafety(args?.query);
  if (refusal) return refusal;
  const research = await listResearch(ctx.orgId, { company: args?.company });
  return { documents: research.slice(0, args?.limit || 10).map((r) => ({ id: r._id.toString(), type: r.type, source: r.source, analyst: r.analyst, date: r.createdAt })) };
}

async function checkExposureLimits(args, ctx) {
  if (!args?.fundId) return { error: "fundId is required." };
  const dashboard = await getExposureDashboard(ctx.orgId, args?.portfolioId);
  return { exposure: dashboard };
}

export const INVESTMENT_TOOL_DECLARATIONS = [
  {
    name: "summarize_thesis",
    description: "Summarize the current investment thesis for a given key — upside/downside, key risks, invalidation criteria. Never a buy/sell recommendation.",
    parameters: { type: Type.OBJECT, properties: { key: { type: Type.STRING }, focus: { type: Type.STRING } }, required: ["key"] },
  },
  {
    name: "compare_thesis_versions",
    description: "Compare the two most recent versions of a thesis to show what changed.",
    parameters: { type: Type.OBJECT, properties: { key: { type: Type.STRING } }, required: ["key"] },
  },
  {
    name: "what_changed_since_last_ic",
    description: "List the most recently updated Investment Committee cases for a fund.",
    parameters: { type: Type.OBJECT, properties: { fundId: { type: Type.STRING } } },
  },
  {
    name: "list_supporting_documents",
    description: "List research documents that support conclusions about a company — cites source, analyst, and date for each.",
    parameters: { type: Type.OBJECT, properties: { company: { type: Type.STRING }, query: { type: Type.STRING }, limit: { type: Type.INTEGER } } },
  },
  {
    name: "check_exposure_limits",
    description: "Get a fund's current exposure breakdown (gross/net/long/short, by issuer/sector/geography/strategy).",
    parameters: { type: Type.OBJECT, properties: { fundId: { type: Type.STRING }, portfolioId: { type: Type.STRING } }, required: ["fundId"] },
  },
];

const TOOL_IMPLEMENTATIONS = {
  summarize_thesis: summarizeThesis,
  compare_thesis_versions: compareThesisVersions,
  what_changed_since_last_ic: whatChangedSinceLastIC,
  list_supporting_documents: listSupportingDocuments,
  check_exposure_limits: checkExposureLimits,
};

export async function runInvestmentTool(name, args, ctx) {
  const impl = TOOL_IMPLEMENTATIONS[name];
  if (!impl) return { error: `Unknown tool: ${name}` };
  return impl(args, ctx);
}

export function investmentSystemInstruction() {
  return `You are the Inaya Investment Research Assistant. You help summarize research, investment theses, Investment Committee history, and exposure — always grounded in what a tool actually returns.

You MUST NEVER: recommend buying, selling, or shorting a specific position, guarantee a return or predict where a position will go, or invent a position/transaction/valuation/compliance approval that a tool didn't actually return. If a thesis comparison or supporting-document search returns nothing, say so plainly rather than filling the gap with general market knowledge. Every conclusion you state about a company must be traceable to a specific research document — cite it. You cannot create, edit, or approve any thesis, IC case, or position — you are read-only, and every real investment decision has to go through the actual Investment Committee process.`;
}
