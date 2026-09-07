// src/lib/ai-audit-tools.js
//
// Financial Services & Regulated Enterprise SOW, Phase 6 (§198) — Audit
// Copilot. Same 4-export shape as ai-compliance-tools.js so it plugs into
// ai-os-router.js identically.
//
// "Read-only by default" (§198's own words) is enforced structurally, not
// by prompt instruction: there is exactly zero mutation tools exposed
// here. An auditor locates evidence, traces control->requirement mapping,
// reviews findings, and identifies gaps — every one of those is a read
// against Phase 4's compliance-controls.js/compliance-evidence.js/
// control-testing.js/internal-audit.js, never a write. generate_evidence_
// package never fabricates a document/export — it returns the metadata
// list of evidence that would go into one, the same "evidence-only,
// never a transactional engine" boundary cap-table.js drew in Phase 3.

import { Type } from "@google/genai";
import { getOrgCollections, toObjectId } from "./orgs.js";
import { listControls } from "./compliance-controls.js";
import { listEvidence } from "./compliance-evidence.js";
import { listFindings } from "./control-testing.js";
import { listAuditPlans } from "./internal-audit.js";
import { getFrameworkRequirements, REFERENCE_DISCLAIMER } from "./compliance-frameworks.js";

export async function buildAuditContext({ orgId, membership, email }) {
  return { orgId, membership, email };
}

// Mirrors ai-compliance-tools.js's PROHIBITED_QUERY_PATTERNS precedent —
// an auditor asking this assistant to certify, guarantee, or declare a
// pass/fail verdict gets a structured refusal, not a fabricated opinion.
// The SOW draws this line at the human auditor, not the AI (§198 doesn't
// grant any certification authority the compliance copilot doesn't
// already lack per §168).
const PROHIBITED_QUERY_PATTERNS = [
  /\bcertif(y|ied|ication)\b/i,
  /\b(are we|is (this|the org(anization)?)) compliant\b/i,
  /\bguarantee/i,
  /\bpass(es)? the audit\b/i,
  /\b(will|would) (this|we) pass\b/i,
  /\bsign off\b/i,
];

function checkAuditQuerySafety(query) {
  if (!query) return null;
  const matched = PROHIBITED_QUERY_PATTERNS.find((p) => p.test(query));
  if (!matched) return null;
  return {
    refused: true,
    reason: "This assistant cannot certify compliance, predict an audit outcome, or sign off on anything. It can only locate evidence, trace control mappings, and summarize findings that already exist — the audit opinion itself has to come from the actual auditor.",
  };
}

async function locateEvidence(args, ctx) {
  const refusal = checkAuditQuerySafety(args?.query);
  if (refusal) return refusal;
  const evidence = await listEvidence(ctx.orgId, { controlId: args?.controlId, reviewStatus: args?.reviewStatus });
  const query = (args?.query || "").toLowerCase();
  const matches = query ? evidence.filter((e) => (e.type || "").toLowerCase().includes(query) || (e.sourceRef || "").toLowerCase().includes(query)) : evidence;
  return {
    evidence: matches.slice(0, args?.limit || 15).map((e) => ({
      id: e._id.toString(), type: e.type, controlId: e.controlId ? e.controlId.toString() : null,
      reviewStatus: e.reviewStatus, validFrom: e.validFrom, validUntil: e.validUntil, sourceRef: e.sourceRef,
    })),
  };
}

async function traceControl(args, ctx) {
  const { complianceControls } = await getOrgCollections();
  const control = await complianceControls.findOne({ _id: toObjectId(args?.controlId), orgId: toObjectId(ctx.orgId) });
  if (!control) return { notFound: true, message: "No control with that ID." };
  const requirementDetails = (control.linkedRequirements || []).map((link) => {
    const requirement = getFrameworkRequirements(link.frameworkId)?.find((r) => r.id === link.requirementId);
    return { frameworkId: link.frameworkId, requirementId: link.requirementId, requirementTitle: requirement?.title || null };
  });
  const evidence = await listEvidence(ctx.orgId, { controlId: args.controlId });
  return {
    control: { id: control._id.toString(), name: control.name, status: control.status, effectiveness: control.effectiveness },
    linkedRequirements: requirementDetails,
    evidenceCount: evidence.length,
    approvedEvidenceCount: evidence.filter((e) => e.reviewStatus === "approved").length,
    referenceDisclaimer: REFERENCE_DISCLAIMER,
  };
}

async function reviewFindings(args, ctx) {
  const findings = await listFindings(ctx.orgId, { status: args?.status, source: args?.source, controlId: args?.controlId });
  return {
    count: findings.length,
    findings: findings.slice(0, args?.limit || 15).map((f) => ({
      id: f._id.toString(), severity: f.severity, description: f.description, status: f.status,
      source: f.source, controlId: f.controlId ? f.controlId.toString() : null, ownerEmail: f.ownerEmail, createdAt: f.createdAt,
    })),
  };
}

// Never assembles an actual file/export — that would be fabricating a
// document this system has no real generation pipeline for. Returns the
// exact metadata list a human would still need to compile themselves.
async function generateEvidencePackage(args, ctx) {
  if (!args?.controlId) return { error: "controlId is required." };
  const [evidence, findings] = await Promise.all([
    listEvidence(ctx.orgId, { controlId: args.controlId, reviewStatus: "approved" }),
    listFindings(ctx.orgId, { controlId: args.controlId }),
  ]);
  return {
    controlId: args.controlId,
    approvedEvidenceItems: evidence.map((e) => ({ id: e._id.toString(), type: e.type, sourceRef: e.sourceRef, validFrom: e.validFrom, validUntil: e.validUntil })),
    relatedFindings: findings.map((f) => ({ id: f._id.toString(), severity: f.severity, status: f.status })),
    note: "This is a list of the evidence records and findings on file for this control — not a generated document. Compiling them into an actual package/export is a manual or separate export step.",
  };
}

async function identifyGaps(args, ctx) {
  const [controls, evidence, findings] = await Promise.all([
    listControls(ctx.orgId, { status: "active" }),
    listEvidence(ctx.orgId, { reviewStatus: "approved" }),
    listFindings(ctx.orgId),
  ]);
  const controlsWithApprovedEvidence = new Set(evidence.filter((e) => e.controlId).map((e) => e.controlId.toString()));
  const controlsMissingEvidence = controls.filter((c) => !controlsWithApprovedEvidence.has(c._id.toString()));
  const controlsNeverTested = controls.filter((c) => c.effectiveness === "not_tested");
  const openFindingsWithNoOwner = findings.filter((f) => f.status !== "CLOSED" && !f.ownerEmail);
  return {
    controlsMissingEvidence: controlsMissingEvidence.map((c) => ({ id: c._id.toString(), name: c.name })),
    controlsNeverTested: controlsNeverTested.map((c) => ({ id: c._id.toString(), name: c.name })),
    openFindingsWithNoOwner: openFindingsWithNoOwner.map((f) => ({ id: f._id.toString(), description: f.description, severity: f.severity })),
  };
}

async function listAuditPlansSummary(args, ctx) {
  const plans = await listAuditPlans(ctx.orgId, { status: args?.status });
  return { auditPlans: plans.map((p) => ({ id: p._id.toString(), name: p.name, status: p.status, line: p.line, findingCount: (p.findingIds || []).length })) };
}

export const AUDIT_TOOL_DECLARATIONS = [
  {
    name: "locate_evidence",
    description: "Locate compliance evidence records, optionally filtered by control, review status, or a keyword match on type/source reference.",
    parameters: { type: Type.OBJECT, properties: { query: { type: Type.STRING }, controlId: { type: Type.STRING }, reviewStatus: { type: Type.STRING }, limit: { type: Type.INTEGER } } },
  },
  {
    name: "trace_control",
    description: "Trace a control to its linked framework requirements and evidence coverage.",
    parameters: { type: Type.OBJECT, properties: { controlId: { type: Type.STRING } }, required: ["controlId"] },
  },
  {
    name: "review_findings",
    description: "Review findings (from control testing or internal audit), optionally filtered by status, source, or control.",
    parameters: { type: Type.OBJECT, properties: { status: { type: Type.STRING }, source: { type: Type.STRING }, controlId: { type: Type.STRING }, limit: { type: Type.INTEGER } } },
  },
  {
    name: "generate_evidence_package",
    description: "List the approved evidence and related findings on file for a control — the raw materials for an evidence package, not a generated document.",
    parameters: { type: Type.OBJECT, properties: { controlId: { type: Type.STRING } }, required: ["controlId"] },
  },
  {
    name: "identify_gaps",
    description: "Identify control-coverage gaps: controls missing approved evidence, controls never tested, and open findings with no assigned owner.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "list_audit_plans",
    description: "List internal audit plans, optionally filtered by status.",
    parameters: { type: Type.OBJECT, properties: { status: { type: Type.STRING } } },
  },
];

const TOOL_IMPLEMENTATIONS = {
  locate_evidence: locateEvidence,
  trace_control: traceControl,
  review_findings: reviewFindings,
  generate_evidence_package: generateEvidencePackage,
  identify_gaps: identifyGaps,
  list_audit_plans: listAuditPlansSummary,
};

export async function runAuditTool(name, args, ctx) {
  const impl = TOOL_IMPLEMENTATIONS[name];
  if (!impl) return { error: `Unknown tool: ${name}` };
  return impl(args, ctx);
}

export function auditSystemInstruction() {
  return `You are the Inaya Audit Copilot. You help an auditor locate evidence, trace control-to-requirement mappings, review findings, and identify coverage gaps — READ-ONLY, always. You have no tool that can change a control, evidence record, finding, or audit plan.

You MUST NEVER: certify compliance, predict or guarantee an audit outcome, sign off on anything, or fabricate an evidence package as though it were an actual generated document — generate_evidence_package only lists what's on file. If asked to certify, guarantee, or predict a pass/fail outcome, refuse plainly and say the audit opinion has to come from the actual auditor. Ground every answer in exactly what a tool returned — never round an "unknown" or missing item into a positive result.`;
}
