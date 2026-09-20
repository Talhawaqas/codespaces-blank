// src/lib/businessEventSimulate.js
//
// Evidence Graph SOW §18/§32 — What If / Simulation. The SOW's strongest
// acceptance test: "a simulation request must NEVER execute the real
// action." This module has NO import of any collection's findOneAndUpdate
// path and NO import of transitionPurchaseOrder/transitionPurchaseRequest/
// reviewAiAction — only their STATE TABLES (PO_TRANSITIONS, PR_TRANSITIONS)
// and the same permission gates those real functions use, read-only. A
// simulation re-derives "would this transition be legal, and is this user
// authorized" using the exact same rule the real transition enforces,
// without ever calling the function that would perform it — so the
// answer is trustworthy, not guessed, while remaining structurally
// incapable of mutating anything.

import { getOrgCollections, canAccessDepartment, canManageOrg, toObjectId } from "./orgs.js";
import { PO_TRANSITIONS } from "./purchase-order-workflow.js";
import { PR_TRANSITIONS } from "./purchase-request-workflow.js";
import { SETTLEMENT_DELAY_MS } from "./ai-action-requests.js";
import { getBusinessEvent } from "./businessEvents.js";
import { logOrgActivity } from "./org-activity-log.js";

const TRANSITION_TABLES = { PURCHASE_ORDER: PO_TRANSITIONS, PURCHASE_REQUEST: PR_TRANSITIONS };

async function loadSubject({ orgId, subjectType, subjectId }) {
  const collections = await getOrgCollections();
  const collectionKey = subjectType === "PURCHASE_ORDER" ? "purchaseOrders" : subjectType === "PURCHASE_REQUEST" ? "purchaseRequests" : subjectType === "AI_ACTION_REQUEST" ? "aiActionRequests" : "invoices";
  return collections[collectionKey].findOne({ _id: toObjectId(subjectId), orgId: toObjectId(orgId) });
}

function simulateWorkflowTransition({ subject, table, action, membership }) {
  const definition = table[action];
  if (!definition) return { legal: false, reason: `Unknown action "${action}".` };
  const fromStates = Array.isArray(definition.from) ? definition.from : [definition.from];
  if (!fromStates.includes(subject.status)) {
    return { legal: false, reason: `Not legal from current state "${subject.status}" (requires ${fromStates.join(" or ")}).`, currentState: subject.status, targetState: definition.to };
  }
  const deptAuthorized = canAccessDepartment(membership, subject.departmentId);
  const manageAuthorized = definition.requiresManage ? canManageOrg(membership) : true;
  return {
    legal: true,
    currentState: subject.status,
    targetState: definition.to,
    authorized: deptAuthorized && manageAuthorized,
    authorizationDetail: { departmentAccess: deptAuthorized, managePermission: definition.requiresManage ? manageAuthorized : "not_required" },
  };
}

function simulateAiActionReview({ subject, decision, membership }) {
  if (!["approve", "reject"].includes(decision)) return { legal: false, reason: `Unknown decision "${decision}".` };
  if (subject.status !== "PENDING_APPROVAL") {
    return { legal: false, reason: `Not legal from current state "${subject.status}" (requires PENDING_APPROVAL).`, currentState: subject.status };
  }
  const now = new Date().toISOString();
  const stillOpen = subject.proposalExpiresAt ? subject.proposalExpiresAt > now : true;
  if (!stillOpen) return { legal: false, reason: "This request has already expired and can no longer be reviewed.", currentState: subject.status };

  const targetState = decision === "approve" ? "APPROVED" : "REJECTED";
  const authorized = canManageOrg(membership); // mirrors the real canApprove gate callers resolve for AI review (owner/admin, or a domain manage-gate — org-manager is the conservative floor this simulation checks)
  const result = { legal: true, currentState: subject.status, targetState, authorized, authorizationDetail: { managePermission: authorized } };
  if (decision === "approve") {
    result.expectedUnlockAt = new Date(Date.now() + SETTLEMENT_DELAY_MS).toISOString();
    result.settlementDelayHours = SETTLEMENT_DELAY_MS / (60 * 60 * 1000);
  }
  return result;
}

/** Read-only. Returns a structured "what would happen" result and NEVER
 *  writes to the subject's collection. The only write anywhere in this
 *  function is an audit log entry on the BUSINESS_EVENT record itself,
 *  explicitly named SIMULATION_RUN — never written against the subject's
 *  own recordType/recordId, so a simulation can never be mistaken for a
 *  real transition when reading that record's own activity history later. */
export async function simulateBusinessEventDecision({ orgId, eventId, action, membership, actorEmail }) {
  const got = await getBusinessEvent({ orgId, eventId, membership });
  if (got.error) return got;
  const event = got.event;

  const subject = await loadSubject({ orgId, subjectType: event.subjectType, subjectId: event.subjectId });
  if (!subject) return { error: "Subject record not found.", status: 404 };

  let result;
  if (event.subjectType === "AI_ACTION_REQUEST") {
    result = simulateAiActionReview({ subject, decision: action, membership });
  } else {
    const table = TRANSITION_TABLES[event.subjectType];
    if (!table) return { error: `Simulation is not supported for subject type "${event.subjectType}".`, status: 400 };
    result = simulateWorkflowTransition({ subject, table, action, membership });
  }

  // Unmodeled downstream effects (SOW §17/§23 "unknown remains explicit"):
  // any relationship this event has recorded is flagged as touched-but-
  // not-recalculated, rather than silently ignored or falsely quantified.
  const unmodeledEffects = (event.relationships || []).map((r) => ({ type: r.targetType, targetId: String(r.targetId), note: "Referenced by this event; downstream impact not modeled by this simulation." }));

  await logOrgActivity({
    orgId, recordType: "BUSINESS_EVENT", recordId: event._id, actorEmail,
    action: "SIMULATION_RUN", previousState: null, newState: null,
    metadata: { proposedAction: action, legal: result.legal, authorized: result.authorized ?? null },
  });

  return {
    simulation: {
      simulationOnly: true,
      noChangesWereMade: true,
      eventId: String(event._id),
      subjectType: event.subjectType,
      subjectId: String(event.subjectId),
      proposedAction: action,
      ...result,
      unmodeledEffects,
    },
  };
}
