// src/lib/ai-compliance-tools.js
//
// Financial Services & Regulated Enterprise SOW, Phase 4 (§86-90) —
// Compliance AI. Same 4-export shape as ai-health-tools.js/
// ai-legal-tools.js so it plugs into ai-os-router.js identically.
//
// DELIBERATE DESIGN CHOICE, same reasoning as ai-health-tools.js: this
// tool set is 100% READ-ONLY — zero propose_* mutation tools. The SOW's
// own §168 is explicit: "AI can identify evidence candidates. AI cannot
// certify compliance." Rather than trust a prompt instruction to hold
// that line, the capability to change a control's status/effectiveness,
// approve evidence, or publish a policy simply isn't exposed as a tool
// here at all — a request that would need one gets a structured refusal.
//
// Every tool reads directly from the org's compliance collections,
// scoped only by orgId (there is no per-record assignment scope for
// compliance data the way there is for patients/matters — visibility is
// role-gated at the API layer via canAccessCompliance/canAccessAudit,
// already checked before ctx is ever built).

import { Type } from "@google/genai";
import { getOrgCollections, toObjectId } from "./orgs.js";
import { listControls } from "./compliance-controls.js";
import { listExpiringEvidence } from "./compliance-evidence.js";
import { listExpiringPolicies } from "./compliance-policies.js";
import { listFindings } from "./control-testing.js";
import { getComplianceHealth } from "./compliance-health.js";

export async function buildComplianceContext({ orgId, membership, email }) {
  return { orgId, membership, email };
}

// A request phrased to elicit a compliance certification, a guarantee,
// or an "are we compliant" verdict is refused at the tool layer, before
// any summarization runs — matching ai-health-tools.js's
// PROHIBITED_QUERY_PATTERNS precedent. Deliberately broad.
const PROHIBITED_QUERY_PATTERNS = [
  /\bcertif(y|ied|ication)\b/i,
  /\b(are we|is (this|the org(anization)?)) compliant\b/i,
  /\bguarantee/i,
  /\bpass(es)? the audit\b/i,
  /\b(prove|confirm) (we('re| are)|the org(anization)? is) compliant\b/i,
];

function checkComplianceQuerySafety(query) {
  if (!query) return null;
  const matched = PROHIBITED_QUERY_PATTERNS.find((p) => p.test(query));
  if (!matched) return null;
  return {
    refused: true,
    reason: "This assistant cannot certify compliance, guarantee an audit outcome, or declare the organization \"compliant.\" It can only summarize controls, evidence, findings, and policies that already exist — the actual compliance determination has to come from your compliance officer or qualified counsel.",
  };
}

async function searchControls(args, ctx) {
  const refusal = checkComplianceQuerySafety(args?.query);
  if (refusal) return refusal;
  const controls = await listControls(ctx.orgId, { status: args?.status, framework: args?.framework });
  const query = (args?.query || "").toLowerCase();
  const matches = query ? controls.filter((c) => c.name.toLowerCase().includes(query) || (c.description || "").toLowerCase().includes(query)) : controls;
  return { controls: matches.slice(0, args?.limit || 10).map((c) => ({ id: c._id.toString(), name: c.name, status: c.status, effectiveness: c.effectiveness, ownerEmail: c.ownerEmail, lastTestedAt: c.lastTestedAt })) };
}

async function getControlDetail(args, ctx) {
  const { complianceControls, complianceControlTests } = await getOrgCollections();
  const control = await complianceControls.findOne({ _id: toObjectId(args?.controlId), orgId: toObjectId(ctx.orgId) });
  if (!control) return { notFound: true, message: "No control with that ID." };
  const tests = await complianceControlTests.find({ controlId: control._id, orgId: toObjectId(ctx.orgId) }).sort({ testedAt: -1 }).limit(3).toArray();
  return {
    control: { id: control._id.toString(), name: control.name, status: control.status, effectiveness: control.effectiveness, linkedRequirements: control.linkedRequirements },
    recentTests: tests.map((t) => ({ method: t.method, result: t.result, testedAt: t.testedAt })),
  };
}

async function listMissingEvidence(args, ctx) {
  const { complianceControls, complianceEvidence } = await getOrgCollections();
  const orgObjectId = toObjectId(ctx.orgId);
  const [controls, evidence] = await Promise.all([
    complianceControls.find({ orgId: orgObjectId, status: { $ne: "retired" } }).toArray(),
    complianceEvidence.find({ orgId: orgObjectId, reviewStatus: "approved" }).toArray(),
  ]);
  const controlsWithApprovedEvidence = new Set(evidence.filter((e) => e.controlId).map((e) => e.controlId.toString()));
  const missing = controls.filter((c) => !controlsWithApprovedEvidence.has(c._id.toString()));
  return { controlsMissingEvidence: missing.map((c) => ({ id: c._id.toString(), name: c.name, status: c.status })) };
}

async function listExpiringPoliciesTool(args, ctx) {
  const policies = await listExpiringPolicies(ctx.orgId, { withinDays: args?.withinDays || 30 });
  return { policies: policies.map((p) => ({ id: p._id.toString(), key: p.key, title: p.title, expiresAt: p.expiresAt })) };
}

async function summarizeOpenFindings(args, ctx) {
  const findings = await listFindings(ctx.orgId, { status: args?.status });
  const open = findings.filter((f) => f.status !== "CLOSED");
  return {
    openCount: open.length,
    criticalCount: open.filter((f) => f.severity === "critical").length,
    findings: open.slice(0, args?.limit || 10).map((f) => ({ id: f._id.toString(), severity: f.severity, description: f.description, status: f.status, source: f.source })),
  };
}

async function getComplianceHealthSummary(args, ctx) {
  // Passed through verbatim — this tool must never re-interpret or
  // "round up" the unknown/passing distinction compliance-health.js
  // already computed correctly.
  return getComplianceHealth(ctx.orgId);
}

async function listUpcomingReviews(args, ctx) {
  const { complianceControls } = await getOrgCollections();
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() + (args?.withinDays || 30) * 24 * 60 * 60 * 1000).toISOString();
  const controls = await complianceControls
    .find({ orgId: toObjectId(ctx.orgId), nextTestDueAt: { $ne: null, $lte: cutoff } })
    .sort({ nextTestDueAt: 1 })
    .toArray();
  return {
    upcomingReviews: controls.map((c) => ({ id: c._id.toString(), name: c.name, nextTestDueAt: c.nextTestDueAt, overdue: c.nextTestDueAt < now })),
  };
}

export const COMPLIANCE_TOOL_DECLARATIONS = [
  {
    name: "search_controls",
    description: "Search the compliance control library by name/description, optionally filtered by status or framework.",
    parameters: { type: Type.OBJECT, properties: { query: { type: Type.STRING }, status: { type: Type.STRING }, framework: { type: Type.STRING }, limit: { type: Type.INTEGER } } },
  },
  {
    name: "get_control_detail",
    description: "Get a control's detail including its linked requirements and its 3 most recent test results.",
    parameters: { type: Type.OBJECT, properties: { controlId: { type: Type.STRING } }, required: ["controlId"] },
  },
  {
    name: "list_missing_evidence",
    description: "List controls that have no approved evidence on file — a control-mapping gap, not a compliance determination.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "list_expiring_policies",
    description: "List published policies expiring within a given number of days (default 30).",
    parameters: { type: Type.OBJECT, properties: { withinDays: { type: Type.INTEGER } } },
  },
  {
    name: "summarize_open_findings",
    description: "Summarize open (non-closed) compliance findings, including how many are critical severity.",
    parameters: { type: Type.OBJECT, properties: { status: { type: Type.STRING }, limit: { type: Type.INTEGER } } },
  },
  {
    name: "get_compliance_health_summary",
    description: "Get the Continuous Compliance dashboard: controls passing/failing/unknown, expiring evidence, open findings, remediation progress, and framework coverage. Never treats 'unknown' as 'passing.'",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "list_upcoming_reviews",
    description: "List controls with a test/review due within a given number of days (default 30), flagging any already overdue.",
    parameters: { type: Type.OBJECT, properties: { withinDays: { type: Type.INTEGER } } },
  },
];

const TOOL_IMPLEMENTATIONS = {
  search_controls: searchControls,
  get_control_detail: getControlDetail,
  list_missing_evidence: listMissingEvidence,
  list_expiring_policies: listExpiringPoliciesTool,
  summarize_open_findings: summarizeOpenFindings,
  get_compliance_health_summary: getComplianceHealthSummary,
  list_upcoming_reviews: listUpcomingReviews,
};

export async function runComplianceTool(name, args, ctx) {
  const impl = TOOL_IMPLEMENTATIONS[name];
  if (!impl) return { error: `Unknown tool: ${name}` };
  return impl(args, ctx);
}

export function complianceSystemInstruction() {
  return `You are the Inaya Regulated Enterprise Assistant. You help summarize the compliance control library, evidence, findings, policies, and the Continuous Compliance dashboard.

You MUST NEVER: certify or declare the organization "compliant," guarantee an audit outcome, fabricate a compliance status for anything a tool doesn't actually return, or blend an "unknown" result into a "passing" one. If get_compliance_health_summary returns unknown counts, report them as unknown explicitly — never round them into "passing" or omit them. If asked to certify compliance or guarantee an audit outcome, refuse plainly and direct the user to their compliance officer or qualified counsel. You cannot change any control, evidence, finding, or policy — you are read-only.`;
}
