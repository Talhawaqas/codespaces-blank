// src/lib/ai-regulatory-tools.js
//
// Financial Services & Regulated Enterprise SOW, Phase 6 (§199) —
// Regulatory Copilot. Same 4-export shape as ai-compliance-tools.js so it
// plugs into ai-os-router.js identically.
//
// §199 lists "regulatory change" as one of this copilot's jobs, but this
// codebase has no live feed of actual regulatory changes to track —
// building one here would mean fabricating a monitoring capability that
// doesn't exist. Per the SOW's own repeated honesty discipline (§88, §168),
// this copilot is explicit about that gap: it can map an org's ENABLED
// frameworks (compliance-frameworks.js's static reference catalog) to
// control coverage and applicability questions, but it does not — and
// says plainly it does not — monitor for new/changed regulation.
//
// "Human review required" (§199's own words) is enforced structurally,
// not by prompt instruction: the one tool that can change anything
// (propose_policy_amendment) never calls compliance-policies.js's
// amendPolicy() directly. It goes through ai-action-requests.js's
// proposeAiAction() — the exact same guarded-action gate every other
// AI-proposed mutation in this codebase uses — so a human with real
// compliance-manager authority must approve it before anything executes.

import { Type } from "@google/genai";
import { getOrgCollections, toObjectId } from "./orgs.js";
import { listFrameworks, getFrameworkRequirements, getOrgEnabledFrameworks, REFERENCE_DISCLAIMER } from "./compliance-frameworks.js";
import { listControls } from "./compliance-controls.js";
import { listEvidence } from "./compliance-evidence.js";
import { listPolicies, listExpiringPolicies } from "./compliance-policies.js";
import { canAccessCompliance } from "./orgGates.js";
import { proposeAiAction } from "./ai-action-requests.js";

export async function buildRegulatoryContext({ orgId, membership, email }) {
  return { orgId, membership, email };
}

const PROHIBITED_QUERY_PATTERNS = [
  /\bis this (a )?legal requirement\b/i,
  /\blegal advice\b/i,
  /\bguarantee/i,
  /\b(are we|is (this|the org(anization)?)) compliant\b/i,
  /\bcertif(y|ied|ication)\b/i,
];

function checkRegulatoryQuerySafety(query) {
  if (!query) return null;
  const matched = PROHIBITED_QUERY_PATTERNS.find((p) => p.test(query));
  if (!matched) return null;
  return {
    refused: true,
    reason: "This assistant cannot give legal advice, certify compliance, or guarantee anything is a legal requirement for your organization. It can only map your enabled frameworks to control/evidence coverage — applicability and legal determinations need qualified legal/compliance counsel.",
  };
}

async function getEnabledFrameworksAndCoverage(args, ctx) {
  const [enabledIds, controls] = await Promise.all([
    getOrgEnabledFrameworks(ctx.orgId),
    listControls(ctx.orgId, { status: "active" }),
  ]);
  const linkedFrameworkIds = new Set(controls.flatMap((c) => (c.linkedRequirements || []).map((l) => l.frameworkId)));
  return {
    enabledFrameworks: enabledIds.map((id) => {
      const framework = listFrameworks().find((f) => f.id === id);
      return { id, name: framework?.name || id, hasAnyLinkedControl: linkedFrameworkIds.has(id) };
    }),
    availableFrameworks: listFrameworks(),
    referenceDisclaimer: REFERENCE_DISCLAIMER,
  };
}

async function checkApplicability(args, ctx) {
  const refusal = checkRegulatoryQuerySafety(args?.query);
  if (refusal) return refusal;
  const requirements = getFrameworkRequirements(args?.frameworkId);
  if (!requirements) return { notFound: true, message: `Unknown framework "${args?.frameworkId}".` };
  return {
    frameworkId: args.frameworkId,
    requirements,
    referenceDisclaimer: REFERENCE_DISCLAIMER,
    note: "This lists the reference requirements for the framework. Whether each one legally applies to your specific organization and jurisdiction is a determination for qualified legal/compliance counsel, not this assistant.",
  };
}

async function listControlMappingGaps(args, ctx) {
  const frameworkId = args?.frameworkId;
  if (!frameworkId) return { error: "frameworkId is required." };
  const requirements = getFrameworkRequirements(frameworkId);
  if (!requirements) return { notFound: true, message: `Unknown framework "${frameworkId}".` };

  const controls = await listControls(ctx.orgId, { framework: frameworkId });
  const coveredRequirementIds = new Set(
    controls.flatMap((c) => (c.linkedRequirements || []).filter((l) => l.frameworkId === frameworkId).map((l) => l.requirementId))
  );
  const uncovered = requirements.filter((r) => !coveredRequirementIds.has(r.id));
  return { frameworkId, uncoveredRequirements: uncovered.map((r) => ({ id: r.id, title: r.title })) };
}

async function listEvidenceGaps(args, ctx) {
  const [controls, evidence] = await Promise.all([
    listControls(ctx.orgId, { status: "active" }),
    listEvidence(ctx.orgId, { reviewStatus: "approved" }),
  ]);
  const controlsWithApprovedEvidence = new Set(evidence.filter((e) => e.controlId).map((e) => e.controlId.toString()));
  const missing = controls.filter((c) => !controlsWithApprovedEvidence.has(c._id.toString()));
  return { controlsMissingEvidence: missing.map((c) => ({ id: c._id.toString(), name: c.name })) };
}

async function listPoliciesNeedingChange(args, ctx) {
  const [expiring, all] = await Promise.all([
    listExpiringPolicies(ctx.orgId, { withinDays: args?.withinDays || 30 }),
    listPolicies(ctx.orgId, { status: "PUBLISHED" }),
  ]);
  const withoutReviewCycle = all.filter((p) => !p.reviewCycleDays);
  return {
    expiringPolicies: expiring.map((p) => ({ id: p._id.toString(), key: p.key, title: p.title, expiresAt: p.expiresAt })),
    publishedWithNoReviewCycle: withoutReviewCycle.map((p) => ({ id: p._id.toString(), key: p.key, title: p.title })),
  };
}

// The one mutation tool — never executes directly. Requires the caller to
// already have at least read/staff-tier compliance access (canAccessCompliance)
// to even PROPOSE an amendment; the real amendPolicy() call only happens
// after a compliance MANAGER approves via the normal AI Action Requests
// review flow (reviewAiAction()'s canApprove gate, checked there).
async function proposePolicyAmendment(args, ctx) {
  if (!args?.policyId || (!args?.title && !args?.body)) {
    return { error: "policyId and at least one of title/body are required." };
  }
  const { compliancePolicies } = await getOrgCollections();
  const policy = await compliancePolicies.findOne({ _id: toObjectId(args.policyId), orgId: toObjectId(ctx.orgId) });
  if (!policy) return { notFound: true, message: "No policy with that ID." };
  if (policy.status !== "PUBLISHED") {
    return { error: `Only a PUBLISHED policy can be amended (this one is ${policy.status}). Use the Policies screen to edit a draft directly.` };
  }

  const result = await proposeAiAction({
    orgId: ctx.orgId,
    assistantSurface: "regulatory",
    toolName: "propose_policy_amendment",
    targetRecordType: "COMPLIANCE_POLICY",
    targetRecordId: args.policyId,
    proposedAction: "amend",
    args: { policyId: args.policyId, title: args.title, body: args.body },
    requestedContextSummary: args.reason || `Proposed amendment to policy "${policy.key}" (v${policy.version}).`,
    actorEmail: ctx.email,
    canPropose: canAccessCompliance(ctx.membership),
  });
  if (result.error) return result;
  return {
    proposed: true,
    requestId: result.request._id.toString(),
    riskLevel: result.request.riskLevel,
    message: "This amendment has been submitted for human review — it will not take effect unless a compliance manager approves it.",
  };
}

export const REGULATORY_TOOL_DECLARATIONS = [
  {
    name: "get_enabled_frameworks_and_coverage",
    description: "List the organization's enabled compliance frameworks and whether each has any linked control, plus the full catalog of available reference frameworks.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "check_applicability",
    description: "Get the reference requirements for a specific framework, with an explicit reminder that legal applicability is a determination for qualified counsel, not this assistant.",
    parameters: { type: Type.OBJECT, properties: { frameworkId: { type: Type.STRING }, query: { type: Type.STRING } }, required: ["frameworkId"] },
  },
  {
    name: "list_control_mapping_gaps",
    description: "List a framework's requirements that have no control linked to them yet.",
    parameters: { type: Type.OBJECT, properties: { frameworkId: { type: Type.STRING } }, required: ["frameworkId"] },
  },
  {
    name: "list_evidence_gaps",
    description: "List active controls that have no approved evidence on file.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "list_policies_needing_change",
    description: "List published policies expiring soon, and published policies with no configured review cycle.",
    parameters: { type: Type.OBJECT, properties: { withinDays: { type: Type.INTEGER } } },
  },
  {
    name: "propose_policy_amendment",
    description: "Propose an amendment (new title and/or body) to a PUBLISHED policy. This does NOT change the policy — it submits a request that a compliance manager must review and approve before anything happens.",
    parameters: {
      type: Type.OBJECT,
      properties: { policyId: { type: Type.STRING }, title: { type: Type.STRING }, body: { type: Type.STRING }, reason: { type: Type.STRING } },
      required: ["policyId"],
    },
  },
];

const TOOL_IMPLEMENTATIONS = {
  get_enabled_frameworks_and_coverage: getEnabledFrameworksAndCoverage,
  check_applicability: checkApplicability,
  list_control_mapping_gaps: listControlMappingGaps,
  list_evidence_gaps: listEvidenceGaps,
  list_policies_needing_change: listPoliciesNeedingChange,
  propose_policy_amendment: proposePolicyAmendment,
};

export async function runRegulatoryTool(name, args, ctx) {
  const impl = TOOL_IMPLEMENTATIONS[name];
  if (!impl) return { error: `Unknown tool: ${name}` };
  return impl(args, ctx);
}

export function regulatorySystemInstruction() {
  return `You are the Inaya Regulatory Copilot. You help map an organization's enabled compliance frameworks to control coverage, evidence gaps, and policies needing attention.

You do NOT track external regulatory changes — you have no live feed of new or amended regulation, and must say so plainly if asked "has anything changed" or similar. You MUST NEVER give legal advice, certify compliance, guarantee an outcome, or declare something a legal requirement — applicability determinations belong to qualified legal/compliance counsel.

You have exactly one tool that changes anything: propose_policy_amendment. Using it never actually changes the policy — it submits a request that requires human review and approval before anything happens. Always tell the user this plainly when you use it. Every other tool is read-only.`;
}
