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
import { logOrgActivity } from "./org-activity-log.js";
import { transitionTask } from "./task-workflow.js";
import { transitionExpense } from "./expense-workflow.js";

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
};

export const AI_ACTION_STATUSES = ["PENDING_APPROVAL", "APPROVED", "REJECTED", "QUEUED", "EXECUTED", "EXPIRED", "CANCELLED"];
export const SETTLEMENT_DELAY_MS = 36 * 60 * 60 * 1000; // 36h, mirrors InayaNodeRegistry.sol's SETTLEMENT_DELAY

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
    status: "PENDING_APPROVAL",
    requestedByEmail: actorEmail || null,
    requestedAt: now,
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

  const updated = await aiActionRequests.findOneAndUpdate(
    { _id: requestObjectId, orgId: orgObjectId, status: "PENDING_APPROVAL" },
    { $set: updateFields },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "This request is no longer pending approval (already reviewed, or doesn't exist).", status: 409 };

  await logOrgActivity({
    orgId: orgObjectId, recordType: "AI_ACTION_REQUEST", recordId: requestObjectId,
    actorEmail, action: decision === "approve" ? "AI_ACTION_APPROVED" : "AI_ACTION_REJECTED",
    previousState: "PENDING_APPROVAL", newState: newStatus, metadata: note ? { note } : {},
  });

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
 *  the meantime) — that's an honest outcome, not a retry-worthy error. */
export async function executeApprovedAiActions() {
  const { aiActionRequests } = await getOrgCollections();
  const now = new Date().toISOString();
  const due = await aiActionRequests.find({ status: "APPROVED", unlockAt: { $lte: now } }).toArray();

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
