// src/lib/ai-private-capital-tools.js
//
// Financial Services & Regulated Enterprise SOW, Phase 3 (§32 Diligence
// AI + Phase 6's "private capital copilot", brought forward for this
// vertical). "private_capital" vertical. Same 4-export shape as every
// other OS-level AI tool set.
//
// §32 is explicit: "AI must not declare a company 'safe' or 'approved'
// automatically" and "every AI finding must be source-backed, confidence-
// labelled, human-reviewable, versioned." 100% READ-ONLY, same discipline
// as ai-investment-tools.js — no propose_* mutation tool exists here;
// diligence conclusions, scorecards, and IC decisions can only be
// recorded by a human through the real workflows in due-diligence.js /
// deal-pipeline.js / investment-committee.js.

import { Type } from "@google/genai";
import { listDeals, listScorecards } from "./deal-pipeline.js";
import { listDiligenceRequests, DILIGENCE_DOMAINS } from "./due-diligence.js";
import { listTermSheets } from "./term-sheet.js";
import { listPortfolioCompanies } from "./portfolio-company.js";
import { getPortfolioMonitoring } from "./portfolio-kpis.js";

export async function buildPrivateCapitalContext({ orgId, membership, email }) {
  return { orgId, membership, email };
}

const PROHIBITED_QUERY_PATTERNS = [
  /\b(is|mark as|declare) (this |the )?(company|deal|target) (safe|approved|clean|good)\b/i,
  /\bshould (we|i) invest\b/i,
  /\bguarantee(d)? (a |the )?(return|exit|outcome)\b/i,
  /\bwill (this|the) (company|deal) succeed\b/i,
];

function checkPrivateCapitalQuerySafety(query) {
  if (!query) return null;
  const matched = PROHIBITED_QUERY_PATTERNS.find((p) => p.test(query));
  if (!matched) return null;
  return { refused: true, reason: "This assistant cannot declare a company safe or approved, recommend an investment decision, or guarantee an outcome. It can only summarize diligence status, scorecards, term sheet history, and portfolio-company data that already exists — the actual investment decision has to come from your Investment Committee." };
}

async function listOpenDiligenceGaps(args, ctx) {
  if (!args?.dealId) return { error: "dealId is required." };
  const requests = await listDiligenceRequests(ctx.orgId, { dealId: args.dealId });
  const coveredDomains = new Set(requests.map((r) => r.domain));
  const missingDomains = DILIGENCE_DOMAINS.filter((d) => !coveredDomains.has(d));
  const openRequests = requests.filter((r) => !["REVIEWED", "CLOSED"].includes(r.status));
  return {
    missingDomains,
    openRequests: openRequests.map((r) => ({ id: r._id.toString(), domain: r.domain, request: r.request, status: r.status, dueDate: r.dueDate })),
  };
}

async function summarizeDealScorecards(args, ctx) {
  if (!args?.dealId) return { error: "dealId is required." };
  const scorecards = await listScorecards(ctx.orgId, args.dealId);
  if (scorecards.length === 0) return { notFound: true, message: "No scorecards submitted for this deal yet." };
  return { scorecards: scorecards.map((s) => ({ evaluatorEmail: s.evaluatorEmail, version: s.version, weightedScore: s.weightedScore, rationale: s.rationale, evaluatedAt: s.evaluatedAt })) };
}

async function compareTermSheetVersions(args, ctx) {
  if (!args?.dealId) return { error: "dealId is required." };
  const termSheets = await listTermSheets(ctx.orgId, args.dealId);
  if (termSheets.length < 2) return { notFound: true, message: "Fewer than two term sheet versions exist for this deal — nothing to compare." };
  const [current, previous] = termSheets;
  return {
    current: { version: current.version, status: current.status, valuation: current.valuation, ownership: current.ownership, liquidationPreference: current.liquidationPreference },
    previous: { version: previous.version, status: previous.status, valuation: previous.valuation, ownership: previous.ownership, liquidationPreference: previous.liquidationPreference },
  };
}

async function listPipelineDeals(args, ctx) {
  const refusal = checkPrivateCapitalQuerySafety(args?.query);
  if (refusal) return refusal;
  const deals = await listDeals(ctx.orgId, { fundId: args?.fundId, stage: args?.stage });
  return { deals: deals.slice(0, args?.limit || 20).map((d) => ({ id: d._id.toString(), company: d.company, stage: d.stage, sector: d.sector, checkSize: d.checkSize })) };
}

async function getPortfolioCompanyMonitoring(args, ctx) {
  if (!args?.portfolioCompanyId) return { error: "portfolioCompanyId is required." };
  const monitoring = await getPortfolioMonitoring(ctx.orgId, args.portfolioCompanyId);
  return { monitoring };
}

export const PRIVATE_CAPITAL_TOOL_DECLARATIONS = [
  {
    name: "list_open_diligence_gaps",
    description: "For a deal, list diligence domains with no request at all, plus every request that isn't yet REVIEWED/CLOSED. Never declares a deal 'diligence-complete' — only reports what's missing or open.",
    parameters: { type: Type.OBJECT, properties: { dealId: { type: Type.STRING } }, required: ["dealId"] },
  },
  {
    name: "summarize_deal_scorecards",
    description: "Summarize the weighted screening scorecards submitted for a deal, with each evaluator's rationale.",
    parameters: { type: Type.OBJECT, properties: { dealId: { type: Type.STRING } }, required: ["dealId"] },
  },
  {
    name: "compare_term_sheet_versions",
    description: "Compare the two most recent negotiation rounds of a deal's term sheet.",
    parameters: { type: Type.OBJECT, properties: { dealId: { type: Type.STRING } }, required: ["dealId"] },
  },
  {
    name: "list_pipeline_deals",
    description: "List deals in the pipeline, optionally filtered by fund or stage.",
    parameters: { type: Type.OBJECT, properties: { fundId: { type: Type.STRING }, stage: { type: Type.STRING }, query: { type: Type.STRING }, limit: { type: Type.INTEGER } } },
  },
  {
    name: "get_portfolio_company_monitoring",
    description: "Get a portfolio company's monitoring snapshot: KPI trend, upcoming board deadlines, open action items, and value-creation plan status.",
    parameters: { type: Type.OBJECT, properties: { portfolioCompanyId: { type: Type.STRING } }, required: ["portfolioCompanyId"] },
  },
];

const TOOL_IMPLEMENTATIONS = {
  list_open_diligence_gaps: listOpenDiligenceGaps,
  summarize_deal_scorecards: summarizeDealScorecards,
  compare_term_sheet_versions: compareTermSheetVersions,
  list_pipeline_deals: listPipelineDeals,
  get_portfolio_company_monitoring: getPortfolioCompanyMonitoring,
};

export async function runPrivateCapitalTool(name, args, ctx) {
  const impl = TOOL_IMPLEMENTATIONS[name];
  if (!impl) return { error: `Unknown tool: ${name}` };
  return impl(args, ctx);
}

export function privateCapitalSystemInstruction() {
  return `You are the Inaya Private Capital Assistant. You help summarize deal pipeline status, diligence gaps, scorecards, term sheet negotiation history, and portfolio-company monitoring — always grounded in what a tool actually returns.

You MUST NEVER: declare a company or deal "safe," "approved," or "clean," recommend an investment decision, guarantee an exit or return, or invent a diligence finding, scorecard, or term that a tool didn't actually return. If diligence gaps exist, list them plainly — never imply a deal is diligence-complete when domains are missing or requests are still open. You cannot create, edit, or approve any deal, scorecard, diligence request, or term sheet — you are read-only, and every real decision has to go through the actual Investment Committee and diligence process.`;
}
