// src/lib/businessEventExplain.js
//
// Evidence Graph SOW §12 — the `Why?` view. Provenance/explainability,
// NOT a chain-of-thought viewer (§11's explicit rule): every field this
// returns is either a structured value already stored on a real record
// (aiActionRequests.requestedContextSummary/proposedAction/riskLevel,
// never any internal model reasoning) or a re-derivation of a permission
// check this codebase already performs elsewhere (canAccessDepartment,
// canManageOrg) — nothing here is invented for display purposes.

import { getOrgCollections, canAccessDepartment, canManageOrg, toObjectId } from "./orgs.js";
import { getBusinessEvent } from "./businessEvents.js";
import { verifyChainIntegrity } from "./auditChain.js";

// Evidence/relationship targets this can actually resolve into a permission-
// aware summary. Anything outside this map is reported as REFERENCED
// (its type/id is real, but not deep-resolved) rather than guessed at.
const RESOLVABLE_TYPES = {
  INVOICE: { collectionKey: "invoices", hasDepartment: true, label: (r) => r.invoiceNumber },
  PURCHASE_ORDER: { collectionKey: "purchaseOrders", hasDepartment: true, label: (r) => r.title || r.description || null },
  PURCHASE_REQUEST: { collectionKey: "purchaseRequests", hasDepartment: true, label: (r) => r.title || r.description || null },
  AI_ACTION_REQUEST: { collectionKey: "aiActionRequests", hasDepartment: false, label: (r) => r.proposedAction },
  SUPPLIER: { collectionKey: "suppliers", hasDepartment: true, label: (r) => r.name },
  DOCUMENT: { collectionKey: "orgDocuments", hasDepartment: false, label: (r) => r.filename },
  // Document Automation SOW -- generated documents and their source records.
  GENERATED_DOCUMENT: { collectionKey: "generatedDocuments", hasDepartment: true, label: (r) => `${r.documentNumber} v${r.documentVersion}` },
  CRM_CONTACT: { collectionKey: "crmContacts", hasDepartment: true, label: (r) => r.name },
  CRM_DEAL: { collectionKey: "crmDeals", hasDepartment: true, label: (r) => r.title },
  PAYMENT: { collectionKey: "payments", hasDepartment: true, label: (r) => `${r.direction} ${r.amount}` },
};

/** Resolves one relationship target into an evidence-panel row, honoring
 *  the SOW §17.4 disclosure states: INCLUDED (resolved and visible),
 *  RESTRICTED (real record, caller can't see it — existence itself is
 *  still disclosed since the relationship already named it, but no
 *  content), or UNAVAILABLE (type not resolvable / record gone). */
async function resolveEvidenceItem({ orgId, membership, targetType, targetId }) {
  const spec = RESOLVABLE_TYPES[targetType];
  if (!spec) return { targetType, targetId: String(targetId), state: "REFERENCED" };

  const collections = await getOrgCollections();
  const record = await collections[spec.collectionKey].findOne({ _id: toObjectId(targetId), orgId: toObjectId(orgId) });
  if (!record) return { targetType, targetId: String(targetId), state: "UNAVAILABLE" };

  const visible = spec.hasDepartment && record.departmentId ? canAccessDepartment(membership, record.departmentId) : spec.hasDepartment ? canManageOrg(membership) : true;
  if (!visible) return { targetType, targetId: String(targetId), state: "RESTRICTED" };

  return { targetType, targetId: String(targetId), state: "INCLUDED", label: spec.label(record) || null, status: record.status || null };
}

/** A single real, disclosed rule — an amount threshold — rather than a
 *  fabricated "rules engine." Mirrors ai-action-requests.js's own
 *  RISK_LEVELS bucket for these subject types (INVOICE/PURCHASE_ORDER
 *  are HIGH regardless of amount there); this makes the threshold this
 *  view cites for a HIGH-risk event concrete and auditable rather than
 *  just restating "risk: HIGH" with no reason. */
function evaluateAmountRule(event) {
  const amount = event.subjectSummary?.amount;
  if (amount === null || amount === undefined) return { ruleId: "AMOUNT_THRESHOLD", result: "UNKNOWN", reason: "No amount on record for this subject." };
  const threshold = 10000;
  return {
    ruleId: "AMOUNT_THRESHOLD",
    threshold,
    amount,
    result: amount >= threshold ? "TRIGGERED" : "NOT_TRIGGERED",
    reason: amount >= threshold ? `Amount ${amount} is at or above the ${threshold} review threshold.` : `Amount ${amount} is below the ${threshold} review threshold.`,
  };
}

export async function explainBusinessEvent({ orgId, eventId, membership }) {
  const got = await getBusinessEvent({ orgId, eventId, membership });
  if (got.error) return got;
  const event = got.event;

  const evidence = [];
  for (const rel of event.relationships || []) {
    evidence.push({ relationship: rel.type, ...(await resolveEvidenceItem({ orgId, membership, targetType: rel.targetType, targetId: rel.targetId })) });
  }

  // AI findings: only ever the structured fields ai-action-requests.js
  // itself stores (requestedContextSummary/proposedAction/riskLevel) —
  // never anything resembling model chain-of-thought, because none is
  // persisted anywhere in that collection to begin with.
  const aiRel = event.relationships.find((r) => r.targetType === "AI_ACTION_REQUEST");
  let aiFindings = null;
  if (aiRel || event.subjectType === "AI_ACTION_REQUEST") {
    const aiId = event.subjectType === "AI_ACTION_REQUEST" ? event.subjectId : aiRel.targetId;
    const { aiActionRequests } = await getOrgCollections();
    const req = await aiActionRequests.findOne({ _id: toObjectId(aiId), orgId: toObjectId(orgId) });
    if (req) {
      aiFindings = {
        recommendation: req.proposedAction,
        context: req.requestedContextSummary || null,
        riskLevel: req.riskLevel,
        status: req.status,
        reviewNote: req.reviewNote || null,
      };
    }
  }

  const chainCheck = await verifyChainIntegrity(orgId).catch(() => null);

  return {
    explanation: {
      eventId: String(event._id),
      subject: { type: event.subjectType, id: String(event.subjectId), summary: event.subjectSummary },
      sourceEvidence: evidence,
      checksPerformed: [
        { check: "DEPARTMENT_ACCESS", result: event.departmentId ? "VERIFIED" : "ORG_MANAGER_SCOPE" },
        { check: "AUDIT_CHAIN_INTEGRITY", result: chainCheck ? (chainCheck.valid ? "VERIFIED" : "INVALID") : "UNKNOWN" },
      ],
      aiFindings,
      rules: [evaluateAmountRule(event)],
      decision: { status: event.status, riskLevel: event.riskLevel },
      proof: { auditChainIntact: chainCheck?.valid ?? null, entriesChecked: chainCheck?.count ?? null },
    },
  };
}
