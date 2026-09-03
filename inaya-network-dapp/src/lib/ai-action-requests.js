// src/lib/ai-action-requests.js
//
// Phase 3/4 — Guarded Execution. An AI assistant never calls a real
// transitionX() directly for a mutating action; it inserts a row here
// (PENDING_APPROVAL) via proposeAiAction(), and a human with the SAME
// authority the real action would require approves or rejects it. On
// approval, unlockAt is set 36 hours out — mirroring
// InayaNodeRegistry.sol's queueSettlement -> SETTLEMENT_DELAY ->
// releaseSettlement two-phase pattern, reimplemented here in Mongo since
// the gated actions (task/expense/etc. transitions) aren't on-chain
// operations. A separate cron executor (Phase 4's
// api/cron/execute-approved-ai-actions route) is the only code path that
// calls the real workflow function, once genuinely unlocked.
//
// STATE MACHINE:
//   PENDING_APPROVAL -> APPROVED   (sets unlockAt = now + 36h)
//   PENDING_APPROVAL -> REJECTED
//   APPROVED         -> CANCELLED (only before unlockAt passes)
//   APPROVED         -> QUEUED    (cron, once unlockAt has passed)
//   QUEUED           -> EXECUTED  (cron, after calling the real transitionX())
//   QUEUED           -> EXPIRED   (cron, if the real transition no longer applies)
//
// AUTHORIZATION: proposeAiAction() takes a `canPropose` boolean the caller
// already resolved via the SAME gate the real action's tool context
// permits (ctx built from getAccessibleScope(), same as every existing AI
// tool). reviewAiAction()'s approve/reject takes a `canApprove` boolean
// the caller resolves via the domain's real requiresManage gate (e.g.
// canManageFinance for an expense decision) — belt-and-suspenders: an
// AI-proposed action can never be approved by someone who couldn't
// already perform the real action themselves.
//
// IDEMPOTENCY: idempotencyKey = sha256(orgId+toolName+targetRecordId+args+
// hour-bucket), uniquely indexed. An identical proposal within the same
// hour upserts into the existing pending request instead of creating a
// duplicate — see proposeAiAction.

import { createHash } from "node:crypto";
import { getOrgCollections, toObjectId } from "./orgs.js";
import { createNotification } from "./notifications.js";
import { logOrgActivity } from "./org-activity-log.js";
import { transitionTask } from "./task-workflow.js";
import { transitionExpense } from "./expense-workflow.js";
import { transitionDocument } from "./document-workflow.js";
import { transitionEmployee } from "./employee-workflow.js";
import { transitionInvoice } from "./invoice-workflow.js";
import { transitionLeaveRequest } from "./leave-workflow.js";
import { transitionPurchaseOrder } from "./purchase-order-workflow.js";
import { transitionPurchaseRequest } from "./purchase-request-workflow.js";
import { transitionDeal } from "./deal-workflow.js";

// Maps a request's targetRecordType to the real workflow transition it's
// eventually allowed to trigger, and how to turn a request's stored args
// into that function's call shape. Adding a new propose_* tool (Phase 4
// only ships two) means adding one entry here, not touching the executor
// loop itself.
// Execution runs as a synthetic org-manager membership, NOT as the
// original approver's real membership — the approval step already
// verified the approver had the exact authority the real transition
// requires (reviewAiAction()'s canApprove gate), so re-deriving THEIR
// membership here would be redundant and would break if their role
// changed between approval and the 36h unlock. What executes is "this
// org's own approved decision," attributed in the activity log to the
// human who approved it (actorEmail below), not to a fabricated identity.
const SYSTEM_EXECUTOR_MEMBERSHIP = { role: "owner" };

const EXECUTORS = {
  TASK: ({ orgId, args, actorEmail }) => transitionTask({ orgId, taskId: args.taskId, action: args.action, membership: SYSTEM_EXECUTOR_MEMBERSHIP, actorEmail, note: "Executed via approved AI action request." }),
  EXPENSE: ({ orgId, args, actorEmail }) => transitionExpense({ orgId, expenseId: args.expenseId, action: args.action, membership: SYSTEM_EXECUTOR_MEMBERSHIP, actorEmail, note: "Executed via approved AI action request." }),
  DOCUMENT: ({ orgId, args, actorEmail }) => transitionDocument({ orgId, documentId: args.documentId, action: args.action, membership: SYSTEM_EXECUTOR_MEMBERSHIP, actorEmail, note: "Executed via approved AI action request." }),
  EMPLOYEE: ({ orgId, args, actorEmail }) => transitionEmployee({ orgId, employeeId: args.employeeId, action: args.action, membership: SYSTEM_EXECUTOR_MEMBERSHIP, actorEmail, note: "Executed via approved AI action request." }),
  INVOICE: ({ orgId, args, actorEmail }) => transitionInvoice({ orgId, invoiceId: args.invoiceId, action: args.action, membership: SYSTEM_EXECUTOR_MEMBERSHIP, actorEmail, note: "Executed via approved AI action request." }),
  LEAVE_REQUEST: ({ orgId, args, actorEmail }) => transitionLeaveRequest({ orgId, leaveRequestId: args.leaveRequestId, action: args.action, membership: SYSTEM_EXECUTOR_MEMBERSHIP, actorEmail, note: "Executed via approved AI action request." }),
  PURCHASE_ORDER: ({ orgId, args, actorEmail }) => transitionPurchaseOrder({ orgId, poId: args.poId, action: args.action, membership: SYSTEM_EXECUTOR_MEMBERSHIP, actorEmail, note: "Executed via approved AI action request." }),
  PURCHASE_REQUEST: ({ orgId, args, actorEmail }) => transitionPurchaseRequest({ orgId, requestId: args.requestId, action: args.action, membership: SYSTEM_EXECUTOR_MEMBERSHIP, actorEmail, note: "Executed via approved AI action request." }),
  DEAL: ({ orgId, args, actorEmail }) => transitionDeal({ orgId, dealId: args.dealId, action: args.action, membership: SYSTEM_EXECUTOR_MEMBERSHIP, actorEmail, note: "Executed via approved AI action request." }),
};

// Enterprise OS SOW, Phase 3 — same "wrap in try/catch, log and continue,
// never let a notification failure break the real transition" discipline
// document-workflow.js's notifyApproversOfSubmission already established.
// Notifies owners/admins specifically (not org-wide) — mirrors that same
// function's role query, since only they can approve any action type
// (module-specific managers like a Finance Manager are a real subset the
// notification center doesn't need to resolve precisely for v1: an
// org-wide informational miss here is lower-risk than a targeted query
// getting a domain's approver rule wrong).
async function notifyOrgManagersOfProposal({ orgObjectId, orgId, request }) {
  try {
    const { orgMembers } = await getOrgCollections();
    const managers = await orgMembers
      .find({ orgId: orgObjectId, role: { $in: ["owner", "admin"] }, status: "active" })
      .toArray();
    await Promise.all(
      managers
        .filter((m) => m.email !== request.requestedByEmail)
        .map((m) =>
          createNotification({
            scope: "org",
            orgId,
            targetEmail: m.email,
            category: "ai",
            severity: request.riskLevel === "HIGH" ? "warning" : "info",
            type: "ai_action_proposed",
            title: `AI proposed: ${request.proposedAction} on ${request.targetRecordType}`,
            body: request.requestedContextSummary || `Proposed by ${request.requestedByEmail || "the AI assistant"} — ${request.riskLevel} risk.`,
            sourceModule: "ai-action-requests",
            sourceId: request._id,
            actionUrl: "/business?view=aiActions",
            dedupeKey: `${orgId}:ai_action_proposed:${request._id}:${m.email}`,
          })
        )
    );
  } catch (err) {
    console.error("notifyOrgManagersOfProposal failed (non-fatal):", err.message);
  }
}

async function notifyProposerOfDecision({ orgId, request, decision }) {
  if (!request.requestedByEmail) return;
  try {
    await createNotification({
      scope: "org",
      orgId,
      targetEmail: request.requestedByEmail,
      category: "ai",
      severity: decision === "reject" ? "warning" : "info",
      type: `ai_action_${decision}d`,
      title: `Your proposed action was ${decision}d`,
      body: `${request.proposedAction} on ${request.targetRecordType}${request.reviewNote ? ` — "${request.reviewNote}"` : ""}`,
      sourceModule: "ai-action-requests",
      sourceId: request._id,
      actionUrl: "/business?view=aiActions",
      dedupeKey: `${orgId}:ai_action_${decision}d:${request._id}`,
    });
  } catch (err) {
    console.error("notifyProposerOfDecision failed (non-fatal):", err.message);
  }
}

export const AI_ACTION_STATUSES = ["PENDING_APPROVAL", "APPROVED", "REJECTED", "QUEUED", "EXECUTED", "EXPIRED", "CANCELLED"];
export const SETTLEMENT_DELAY_MS = 36 * 60 * 60 * 1000; // 36h, mirrors InayaNodeRegistry.sol's SETTLEMENT_DELAY
export const PROPOSAL_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — Phase 10, distinct from the post-approval unlockAt delay above

// Phase 5 — Action Risk Classification. Keyed first by "targetRecordType:action"
// for domains where risk genuinely varies by action, falling back to a
// per-domain default. classifyRisk() never returns undefined — an
// unrecognized combination defaults to MEDIUM rather than silently
// under-classifying as LOW.
const RISK_LEVELS = {
  TASK: "LOW",
  "DOCUMENT:submit": "LOW",
  "DOCUMENT:revise": "LOW",
  "DOCUMENT:startReview": "MEDIUM",
  "DOCUMENT:approve": "MEDIUM",
  "DOCUMENT:reject": "MEDIUM",
  "DOCUMENT:archive": "MEDIUM",
  "DOCUMENT:restore": "MEDIUM",
  "DEAL:advance": "LOW",
  "DEAL:regress": "LOW",
  "DEAL:win": "MEDIUM",
  "DEAL:lose": "MEDIUM",
  "DEAL:reopen": "MEDIUM",
  "PURCHASE_REQUEST:submit": "MEDIUM",
  "PURCHASE_REQUEST:cancel": "MEDIUM",
  "PURCHASE_REQUEST:approve": "HIGH",
  "PURCHASE_REQUEST:reject": "HIGH",
  "LEAVE_REQUEST:approve": "MEDIUM",
  "LEAVE_REQUEST:reject": "MEDIUM",
  "LEAVE_REQUEST:cancel": "MEDIUM",
  "EMPLOYEE:activate": "MEDIUM",
  "EMPLOYEE:placeOnLeave": "MEDIUM",
  "EMPLOYEE:returnFromLeave": "MEDIUM",
  "EMPLOYEE:terminate": "HIGH",
  EXPENSE: "HIGH",
  INVOICE: "HIGH",
  PURCHASE_ORDER: "HIGH",
};

export function classifyRisk(targetRecordType, proposedAction) {
  return RISK_LEVELS[`${targetRecordType}:${proposedAction}`] || RISK_LEVELS[targetRecordType] || "MEDIUM";
}

function computeIdempotencyKey({ orgId, toolName, targetRecordId, args }) {
  const hourBucket = Math.floor(Date.now() / (60 * 60 * 1000));
  const raw = `${orgId}:${toolName}:${targetRecordId || ""}:${JSON.stringify(args || {})}:${hourBucket}`;
  return createHash("sha256").update(raw).digest("hex");
}

/** The floor every AI-proposed action must clear: whatever gate the real
 *  transitionX() would itself require. Callers pass in the result of
 *  calling that real gate (e.g. canManageFinance(membership) for an
 *  expense decision, or just membership-exists for a requiresManage:false
 *  transition) — this function doesn't know the domain-specific rule, it
 *  only enforces that SOME check was actually performed and passed. */
export function requireAiActionAllowed({ allowed, reason }) {
  if (!allowed) return { error: reason || "You don't have permission to propose or approve that action.", status: 403 };
  return { ok: true };
}

/** Inserts a new PENDING_APPROVAL request, or upserts into an existing
 *  identical one from within the same hour (idempotency). Returns
 *  { request } or { error, status }. */
export async function proposeAiAction({
  orgId, assistantSurface, toolName, targetRecordType, targetRecordId,
  proposedAction, args, requestedContextSummary, actorEmail, canPropose,
}) {
  const gate = requireAiActionAllowed({ allowed: canPropose, reason: "You don't have permission to propose this action." });
  if (gate.error) return gate;

  const { aiActionRequests } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const idempotencyKey = computeIdempotencyKey({ orgId, toolName, targetRecordId, args });
  const now = new Date().toISOString();

  const existing = await aiActionRequests.findOne({ idempotencyKey });
  if (existing) return { request: existing, deduped: true };

  const request = {
    orgId: orgObjectId,
    assistantSurface,
    toolName,
    targetRecordType,
    targetRecordId: targetRecordId ? toObjectId(targetRecordId) : null,
    proposedAction,
    args: args || {},
    requestedContextSummary: requestedContextSummary || "",
    riskLevel: classifyRisk(targetRecordType, proposedAction),
    status: "PENDING_APPROVAL",
    requestedByEmail: actorEmail || null,
    requestedAt: now,
    proposalExpiresAt: new Date(Date.now() + PROPOSAL_EXPIRY_MS).toISOString(),
    reviewedByEmail: null,
    reviewedAt: null,
    reviewNote: null,
    unlockAt: null,
    executedAt: null,
    executionResult: null,
    idempotencyKey,
  };

  let inserted;
  try {
    const { insertedId } = await aiActionRequests.insertOne(request);
    inserted = { ...request, _id: insertedId };
  } catch (err) {
    if (err?.code === 11000) {
      // Lost a race to an identical concurrent proposal — return the one
      // that won, same "read what's actually there" convention as every
      // other duplicate-key handler in this codebase.
      const winner = await aiActionRequests.findOne({ idempotencyKey });
      return { request: winner, deduped: true };
    }
    throw err;
  }

  await logOrgActivity({
    orgId: orgObjectId, recordType: "AI_ACTION_REQUEST", recordId: inserted._id,
    actorEmail, action: "AI_ACTION_PROPOSED", previousState: null, newState: "PENDING_APPROVAL",
    metadata: { toolName, targetRecordType, targetRecordId: targetRecordId ? targetRecordId.toString() : null },
  });

  await notifyOrgManagersOfProposal({ orgObjectId, orgId, request: inserted });

  return { request: inserted };
}

/** Approve or reject a PENDING_APPROVAL request. Approval sets unlockAt
 *  36h out; nothing executes until Phase 4's cron finds it past that. */
export async function reviewAiAction({ orgId, requestId, decision, actorEmail, note, canApprove }) {
  if (!["approve", "reject"].includes(decision)) return { error: `Unknown decision "${decision}".`, status: 400 };
  const gate = requireAiActionAllowed({ allowed: canApprove, reason: "You don't have permission to review this action." });
  if (gate.error) return gate;

  const { aiActionRequests } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const requestObjectId = toObjectId(requestId);
  const now = new Date().toISOString();

  const newStatus = decision === "approve" ? "APPROVED" : "REJECTED";
  const updateFields = { status: newStatus, reviewedByEmail: actorEmail || null, reviewedAt: now, reviewNote: note || null };
  if (newStatus === "APPROVED") updateFields.unlockAt = new Date(Date.now() + SETTLEMENT_DELAY_MS).toISOString();

  // Phase 10 / Phase 14: a PENDING_APPROVAL request past its proposalExpiresAt
  // can no longer be approved or rejected, even if the daily expiry sweep
  // hasn't run yet — this is a synchronous, race-safe backstop (the filter
  // itself excludes an expired row, so a concurrent approve attempt fails
  // closed rather than racing the cron).
  const updated = await aiActionRequests.findOneAndUpdate(
    { _id: requestObjectId, orgId: orgObjectId, status: "PENDING_APPROVAL", proposalExpiresAt: { $gt: now } },
    { $set: updateFields },
    { returnDocument: "after" }
  );
  if (!updated) {
    const stillPending = await aiActionRequests.findOne({ _id: requestObjectId, orgId: orgObjectId, status: "PENDING_APPROVAL" });
    if (stillPending) return { error: "This request has expired and can no longer be approved or rejected.", status: 409 };
    return { error: "This request is no longer pending approval (already reviewed, or doesn't exist).", status: 409 };
  }

  await logOrgActivity({
    orgId: orgObjectId, recordType: "AI_ACTION_REQUEST", recordId: requestObjectId,
    actorEmail, action: decision === "approve" ? "AI_ACTION_APPROVED" : "AI_ACTION_REJECTED",
    previousState: "PENDING_APPROVAL", newState: newStatus, metadata: note ? { note } : {},
  });

  await notifyProposerOfDecision({ orgId, request: updated, decision });

  return { request: updated };
}

/** Cancel an APPROVED-but-not-yet-unlocked request — allowed by the
 *  approver or an org manager (SOW's explicit cancellation rule), never
 *  after unlockAt has passed (at that point the cron may already be
 *  executing it). */
export async function cancelAiAction({ orgId, requestId, actorEmail, canCancel }) {
  const gate = requireAiActionAllowed({ allowed: canCancel, reason: "You don't have permission to cancel this action." });
  if (gate.error) return gate;

  const { aiActionRequests } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const requestObjectId = toObjectId(requestId);
  const now = new Date().toISOString();

  const updated = await aiActionRequests.findOneAndUpdate(
    { _id: requestObjectId, orgId: orgObjectId, status: "APPROVED", unlockAt: { $gt: now } },
    { $set: { status: "CANCELLED", reviewedByEmail: actorEmail || null, reviewedAt: now } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "This request can no longer be cancelled (not approved-and-pending, or already past its unlock time).", status: 409 };

  await logOrgActivity({
    orgId: orgObjectId, recordType: "AI_ACTION_REQUEST", recordId: requestObjectId,
    actorEmail, action: "AI_ACTION_CANCELLED", previousState: "APPROVED", newState: "CANCELLED", metadata: {},
  });

  return { request: updated };
}

export async function listAiActionRequests({ orgId, status }) {
  const { aiActionRequests } = await getOrgCollections();
  const filter = { orgId: toObjectId(orgId) };
  if (status) filter.status = status;
  return aiActionRequests.find(filter).sort({ requestedAt: -1 }).toArray();
}

/** The cron entry point (api/cron/execute-approved-ai-actions) — finds
 *  every APPROVED request across every org whose unlockAt has passed,
 *  atomically claims each one (APPROVED -> QUEUED, findOneAndUpdate status
 *  guard — the same replay-safe pattern every workflow transition in this
 *  codebase already uses, so two overlapping cron invocations can never
 *  execute the same request twice), then calls the real transitionX().
 *  QUEUED -> EXECUTED on success; QUEUED -> EXPIRED if the real transition
 *  no longer applies (e.g. the task/expense moved to some other state in
 *  the meantime) — that's an honest outcome, not a retry-worthy error.
 *  `orgId` is optional and exists ONLY so tests can scope a sweep to their
 *  own fixture org without also processing every other org's genuinely-due
 *  requests on a shared database — the real cron route never passes it, so
 *  production behavior (org-agnostic, system-wide) is unchanged. */
export async function executeApprovedAiActions({ orgId } = {}) {
  const { aiActionRequests } = await getOrgCollections();
  const now = new Date().toISOString();
  const filter = { status: "APPROVED", unlockAt: { $lte: now } };
  if (orgId) filter.orgId = toObjectId(orgId);
  const due = await aiActionRequests.find(filter).toArray();

  const results = { claimed: 0, executed: 0, expired: 0 };
  for (const request of due) {
    const queued = await aiActionRequests.findOneAndUpdate(
      { _id: request._id, status: "APPROVED" },
      { $set: { status: "QUEUED" } },
      { returnDocument: "after" }
    );
    if (!queued) continue; // another concurrent run already claimed it
    results.claimed += 1;

    const executor = EXECUTORS[queued.targetRecordType];
    let executionResult;
    try {
      executionResult = executor
        ? await executor({ orgId: queued.orgId, args: queued.args, actorEmail: queued.reviewedByEmail })
        : { error: `No executor registered for targetRecordType "${queued.targetRecordType}".`, status: 500 };
    } catch (err) {
      executionResult = { error: err.message, status: 500 };
    }

    const executedAt = new Date().toISOString();
    if (executionResult.error) {
      // A 409 from the real transition means the record's state moved on
      // its own since approval (someone else already handled it, or it
      // was cancelled through the normal UI) — that's EXPIRED, an honest
      // outcome. Anything else (404, 500) is still recorded as EXPIRED
      // rather than left stuck in QUEUED forever; the reason is preserved
      // in executionResult for operators to inspect.
      await aiActionRequests.updateOne({ _id: queued._id }, { $set: { status: "EXPIRED", executedAt, executionResult: { error: executionResult.error } } });
      await logOrgActivity({
        orgId: queued.orgId, recordType: "AI_ACTION_REQUEST", recordId: queued._id,
        actorEmail: queued.reviewedByEmail, action: "AI_ACTION_EXPIRED", previousState: "QUEUED", newState: "EXPIRED",
        metadata: { reason: executionResult.error },
      });
      results.expired += 1;
    } else {
      await aiActionRequests.updateOne({ _id: queued._id }, { $set: { status: "EXECUTED", executedAt, executionResult: { success: true } } });
      await logOrgActivity({
        orgId: queued.orgId, recordType: "AI_ACTION_REQUEST", recordId: queued._id,
        actorEmail: queued.reviewedByEmail, action: "AI_ACTION_EXECUTED", previousState: "QUEUED", newState: "EXECUTED", metadata: {},
      });
      results.executed += 1;
    }
  }

  return results;
}

/** Phase 10 — Action Expiration. A PENDING_APPROVAL request nobody reviewed
 *  within PROPOSAL_EXPIRY_MS is stale: the business data it was proposed
 *  against may no longer look like it did when the AI proposed it, so it
 *  must not remain approvable indefinitely. Distinct from unlockAt above —
 *  this expires an UNREVIEWED proposal, not a reviewed-and-waiting one.
 *  Same atomic per-row claim as executeApprovedAiActions, called from the
 *  same daily cron. `orgId` is optional test-scoping only — see
 *  executeApprovedAiActions's comment above, same reasoning applies here. */
export async function expireStalePendingActions({ orgId } = {}) {
  const { aiActionRequests } = await getOrgCollections();
  const now = new Date().toISOString();
  const filter = { status: "PENDING_APPROVAL", proposalExpiresAt: { $lte: now } };
  if (orgId) filter.orgId = toObjectId(orgId);
  const stale = await aiActionRequests.find(filter).toArray();

  let expired = 0;
  for (const request of stale) {
    const updated = await aiActionRequests.findOneAndUpdate(
      { _id: request._id, status: "PENDING_APPROVAL" },
      { $set: { status: "EXPIRED", executedAt: now, executionResult: { error: "Proposal expired before it was reviewed." } } },
      { returnDocument: "after" }
    );
    if (!updated) continue; // reviewed (or already expired) by a concurrent request in between
    expired += 1;
    await logOrgActivity({
      orgId: updated.orgId, recordType: "AI_ACTION_REQUEST", recordId: updated._id,
      actorEmail: null, action: "AI_ACTION_EXPIRED", previousState: "PENDING_APPROVAL", newState: "EXPIRED",
      metadata: { reason: "proposal_expired_unreviewed" },
    });
  }

  return { expired };
}
