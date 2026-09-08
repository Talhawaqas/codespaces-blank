// src/lib/ai-government-tools.js
//
// Government & Public Sector Sovereign OS SOW, Phase 1+3 (§E "Controlled
// Government AI"). Same 4-export shape as ai-compliance-tools.js/
// ai-health-tools.js so it plugs into ai-os-router.js identically.
//
// DELIBERATE DESIGN CHOICE, same reasoning as ai-compliance-tools.js and
// ai-health-tools.js: this tool set is 100% READ-ONLY — zero propose_*
// or mutation tools. The SOW's own §E is explicit: AI must operate under
// "Permission -> Proposal -> Human Review -> Approval -> Controlled
// Execution -> Audit" and must NOT independently make final government
// decisions, override permissions, release protected information, delete
// protected records, or execute high-risk actions without authorized
// approval. Rather than trust a prompt instruction to hold that line, the
// capability to change a case's status, publish a policy, or release a
// citizen record simply isn't exposed as a tool here at all.
//
// NEED-TO-KNOW IS ENFORCED HERE TOO, not just at the API layer:
// search_citizen_records only ever returns records the CALLER (via ctx's
// already-resolved membership) is actually assigned to — reuses
// requireCitizenRecordAccess()'s exact same check per-record, rather than
// re-deriving a parallel visibility rule. An AI assistant must never be
// able to see more than the human it's acting on behalf of could.

import { Type } from "@google/genai";
import { getOrgCollections, toObjectId } from "./orgs.js";
import { listCitizenRecords, requireCitizenRecordAccess } from "./citizen-records.js";
import { listCases, getCase } from "./government-cases.js";
import { listEntries } from "./policy-knowledge-base.js";
import { getGovernmentDashboard } from "./government-dashboard.js";

export async function buildGovernmentContext({ orgId, membership, email }) {
  return { orgId, membership, email };
}

// A request phrased to elicit a final government decision, an override of
// permissions, or release of protected information is refused at the tool
// layer, before any summarization runs — matching ai-compliance-tools.js's
// PROHIBITED_QUERY_PATTERNS precedent. Deliberately broad.
const PROHIBITED_QUERY_PATTERNS = [
  /\b(approve|deny|reject|grant|authorize) (this|the) (case|request|record|access)\b/i,
  /\bmake the (final )?decision\b/i,
  /\boverride (permission|access|approval)/i,
  /\brelease (this|the) (protected |classified |confidential )?(record|information|document)\b/i,
  /\bdelete (this|the) (record|case|document)\b/i,
  /\bwithout (approval|review|authorization)\b/i,
];

function checkGovernmentQuerySafety(query) {
  if (!query) return null;
  const matched = PROHIBITED_QUERY_PATTERNS.find((p) => p.test(query));
  if (!matched) return null;
  return {
    refused: true,
    reason: "This assistant cannot make a final government decision, override a permission, release protected information, or delete a protected record. It can only search and summarize records, cases, and policy knowledge base entries you're already authorized to see — any action beyond that has to go through the normal human-approval workflow.",
  };
}

/** Need-to-know enforced per-record — never returns a citizen record's
 *  content unless requireCitizenRecordAccess() confirms this specific
 *  caller is actually assigned to it, exactly the same check the API
 *  layer uses when a human opens the record directly. */
async function searchCitizenRecords(args, ctx) {
  const refusal = checkGovernmentQuerySafety(args?.query);
  if (refusal) return refusal;

  const listResult = await listCitizenRecords(ctx.orgId, { status: args?.status, department: args?.department, membership: ctx.membership });
  if (listResult.error) return { error: listResult.error };

  const query = (args?.query || "").toLowerCase();
  const candidates = query ? listResult.records.filter((r) => r.legalName.toLowerCase().includes(query)) : listResult.records;

  // The list above is already metadata-only; further narrow to records
  // this caller is actually assigned to before returning anything.
  const accessible = [];
  for (const candidate of candidates.slice(0, (args?.limit || 10) * 2)) {
    const access = await requireCitizenRecordAccess({ orgId: ctx.orgId, recordId: candidate._id, membership: ctx.membership, actorEmail: ctx.email });
    if (!access.error) accessible.push({ id: candidate._id.toString(), legalName: candidate.legalName, status: candidate.status, department: candidate.department });
    if (accessible.length >= (args?.limit || 10)) break;
  }
  return { records: accessible, note: accessible.length === 0 ? "No matching records you're assigned to were found — need-to-know access means this may differ from a full org-wide search." : undefined };
}

async function summarizeCase(args, ctx) {
  if (!args?.caseId) return { error: "caseId is required." };
  const result = await getCase({ orgId: ctx.orgId, caseId: args.caseId, membership: ctx.membership });
  if (result.error) return { error: result.error };
  const c = result.case;
  return {
    case: {
      id: c._id.toString(), title: c.title, category: c.category, priority: c.priority,
      status: c.status, department: c.department, ownerEmail: c.ownerEmail,
      timelineEventCount: c.timeline.length, createdAt: c.createdAt, resolvedAt: c.resolvedAt,
    },
  };
}

async function listOpenCasesTool(args, ctx) {
  const result = await listCases(ctx.orgId, { status: args?.status, category: args?.category, department: args?.department, membership: ctx.membership });
  if (result.error) return { error: result.error };
  const cases = args?.status ? result.cases : result.cases.filter((c) => c.status !== "CLOSED");
  return { cases: cases.slice(0, args?.limit || 10).map((c) => ({ id: c._id.toString(), title: c.title, category: c.category, priority: c.priority, status: c.status })) };
}

async function searchPolicyKb(args, ctx) {
  const result = await listEntries(ctx.orgId, { status: "PUBLISHED", membership: ctx.membership });
  if (result.error) return { error: result.error };
  const query = (args?.query || "").toLowerCase();
  const matches = query ? result.entries.filter((e) => e.title.toLowerCase().includes(query) || (e.body || "").toLowerCase().includes(query)) : result.entries;
  return { entries: matches.slice(0, args?.limit || 10).map((e) => ({ id: e._id.toString(), key: e.key, title: e.title, version: e.version, effectiveDate: e.effectiveDate })) };
}

async function getDashboardSummary(args, ctx) {
  // Passed through verbatim — must never re-interpret or "round up" the
  // unknown/valid distinction government-dashboard.js already computed.
  return getGovernmentDashboard(ctx.orgId);
}

async function draftReport(args, ctx) {
  // §E "Report preparation" — explicitly a DRAFT the tool hands back as
  // text for a human to review and actually issue, never something this
  // tool itself publishes or sends anywhere. No write path exists here.
  const dashboard = await getGovernmentDashboard(ctx.orgId);
  const { citizenRecords } = await getOrgCollections();
  const orgObjectId = toObjectId(ctx.orgId);
  void citizenRecords; void orgObjectId; // dashboard already aggregates what's needed; kept for future extension without re-deriving orgId handling
  return {
    draftReport: {
      summaryLine: `${dashboard.operations.openCases} open case(s) across ${Object.keys(dashboard.operations.casesByCategory).length} categor${Object.keys(dashboard.operations.casesByCategory).length === 1 ? "y" : "ies"}; audit chain status: ${dashboard.security.auditChainStatus}; ${dashboard.security.unreviewedBreakGlassGrants} break-glass grant(s) awaiting review.`,
      operations: dashboard.operations,
      security: dashboard.security,
      note: "This is a draft summary generated from current data only — it is not an official report until a human reviews and issues it.",
    },
  };
}

export const GOVERNMENT_TOOL_DECLARATIONS = [
  {
    name: "search_citizen_records",
    description: "Search citizen records you are assigned to (need-to-know enforced — records you aren't assigned to are never returned, even if they exist).",
    parameters: { type: Type.OBJECT, properties: { query: { type: Type.STRING }, status: { type: Type.STRING }, department: { type: Type.STRING }, limit: { type: Type.INTEGER } } },
  },
  {
    name: "summarize_case",
    description: "Get a case's summary (status, priority, owner, timeline length) — respects the same citizen-record link access check a human would need.",
    parameters: { type: Type.OBJECT, properties: { caseId: { type: Type.STRING } }, required: ["caseId"] },
  },
  {
    name: "list_open_cases",
    description: "List open (non-closed) government cases, optionally filtered by status, category, or department.",
    parameters: { type: Type.OBJECT, properties: { status: { type: Type.STRING }, category: { type: Type.STRING }, department: { type: Type.STRING }, limit: { type: Type.INTEGER } } },
  },
  {
    name: "search_policy_kb",
    description: "Search published Policy Knowledge Base entries by title or body text.",
    parameters: { type: Type.OBJECT, properties: { query: { type: Type.STRING }, limit: { type: Type.INTEGER } } },
  },
  {
    name: "get_dashboard_summary",
    description: "Get the Government OS operations + security readiness dashboard: case KPIs, audit chain status, and unreviewed break-glass grants. Never treats 'unknown' as a passing status.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "draft_report",
    description: "Draft a plain-text operational/KPI report summary from current data — a draft only, never automatically issued or sent.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
];

const TOOL_IMPLEMENTATIONS = {
  search_citizen_records: searchCitizenRecords,
  summarize_case: summarizeCase,
  list_open_cases: listOpenCasesTool,
  search_policy_kb: searchPolicyKb,
  get_dashboard_summary: getDashboardSummary,
  draft_report: draftReport,
};

export async function runGovernmentTool(name, args, ctx) {
  const impl = TOOL_IMPLEMENTATIONS[name];
  if (!impl) return { error: `Unknown tool: ${name}` };
  return impl(args, ctx);
}

export function governmentSystemInstruction() {
  return `You are the Inaya Government Assistant. You help search citizen records you're authorized to see, summarize cases, search the Policy Knowledge Base, and prepare draft operational reports.

You MUST NEVER: make a final government decision, override a permission or approval requirement, release protected or classified information, delete a protected record, or take any high-risk action without human approval. You cannot change any citizen record, case, or policy entry — you are read-only. Every citizen record you can discuss is one the current user is actually assigned to (need-to-know) — if a search returns nothing, that may mean the records exist but the user isn't assigned to them, not that they don't exist; say so honestly rather than implying a broader search happened. If asked to approve, override, release, or decide something, refuse plainly and direct the user to the normal human-approval workflow. This assistant makes no claim of government certification, authorization, or compliance with any specific jurisdiction's regulations.`;
}
