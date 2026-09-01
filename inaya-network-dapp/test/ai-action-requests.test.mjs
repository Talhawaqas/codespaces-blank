// test/ai-action-requests.test.mjs
//
// Guarded Execution unit coverage: idempotency dedup, risk classification
// (Phase 5), the approve/reject/cancel state machine, atomic-claim replay
// safety in executeApprovedAiActions, and proposal-level expiration
// (Phase 10, expireStalePendingActions). Same node --test + real Atlas +
// RUN_ID-fixtures convention as test/audit-chain.test.mjs.
//
// executeApprovedAiActions/expireStalePendingActions are real cron entry
// points with NO orgId scoping by default (they sweep every org on a real
// deploy) — every call here passes { orgId } explicitly so this test only
// ever touches its own fixtures, never any other org's genuinely-due
// request on a shared database. See ai-action-requests.js's comment on
// both functions for why that parameter exists.
//
// Run with: node --env-file=.env.local --test test/ai-action-requests.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import {
  proposeAiAction, reviewAiAction, cancelAiAction, listAiActionRequests,
  executeApprovedAiActions, expireStalePendingActions, classifyRisk,
} from "../src/lib/ai-action-requests.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const email = (label) => `test-aiaction-${RUN_ID}-${label}@example.com`;

let collections;
const cleanup = { orgIds: [] };

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
});

after(async () => {
  const { aiActionRequests, orgActivity, auditChainEntries, auditChainHeads } = collections;
  await aiActionRequests.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await orgActivity.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await auditChainEntries.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await auditChainHeads.deleteMany({ orgId: { $in: cleanup.orgIds } });
  const client = await mongoClientPromise;
  await client.close();
});

function newOrgId() {
  const id = new ObjectId();
  cleanup.orgIds.push(id);
  return id;
}

test("classifyRisk: known combinations resolve to the SOW's Phase 5 levels, unknowns default to MEDIUM", () => {
  assert.equal(classifyRisk("TASK", "start"), "LOW");
  assert.equal(classifyRisk("DOCUMENT", "submit"), "LOW");
  assert.equal(classifyRisk("DOCUMENT", "approve"), "MEDIUM");
  assert.equal(classifyRisk("EXPENSE", "approve"), "HIGH");
  assert.equal(classifyRisk("PURCHASE_REQUEST", "approve"), "HIGH");
  assert.equal(classifyRisk("PURCHASE_REQUEST", "submit"), "MEDIUM");
  assert.equal(classifyRisk("SOMETHING_UNRECOGNIZED", "whatever"), "MEDIUM");
});

test("proposeAiAction: sets riskLevel and proposalExpiresAt on the created request", async () => {
  const orgId = newOrgId();
  const targetRecordId = new ObjectId();

  const { request } = await proposeAiAction({
    orgId, assistantSurface: "business", toolName: "propose_expense_decision",
    targetRecordType: "EXPENSE", targetRecordId, proposedAction: "approve",
    args: { expenseId: targetRecordId.toString(), action: "approve" },
    requestedContextSummary: "test", actorEmail: email("a"), canPropose: true,
  });

  assert.equal(request.riskLevel, "HIGH");
  assert.equal(request.status, "PENDING_APPROVAL");
  assert.ok(request.proposalExpiresAt, "proposalExpiresAt should be set");
  assert.ok(new Date(request.proposalExpiresAt).getTime() > Date.now(), "proposalExpiresAt should be in the future");
});

test("proposeAiAction: canPropose:false is rejected, no row inserted", async () => {
  const orgId = newOrgId();
  const targetRecordId = new ObjectId();

  const result = await proposeAiAction({
    orgId, assistantSurface: "business", toolName: "propose_task_status_change",
    targetRecordType: "TASK", targetRecordId, proposedAction: "start",
    args: { taskId: targetRecordId.toString(), action: "start" },
    requestedContextSummary: "test", actorEmail: email("b"), canPropose: false,
  });

  assert.equal(result.status, 403);
  const list = await listAiActionRequests({ orgId });
  assert.equal(list.length, 0);
});

test("proposeAiAction: an identical proposal within the same hour dedupes via idempotency key", async () => {
  const orgId = newOrgId();
  const targetRecordId = new ObjectId();
  const proposeOnce = () => proposeAiAction({
    orgId, assistantSurface: "business", toolName: "propose_task_status_change",
    targetRecordType: "TASK", targetRecordId, proposedAction: "start",
    args: { taskId: targetRecordId.toString(), action: "start" },
    requestedContextSummary: "test", actorEmail: email("c"), canPropose: true,
  });

  const first = await proposeOnce();
  const second = await proposeOnce();

  assert.equal(first.request._id.toString(), second.request._id.toString());
  assert.equal(second.deduped, true);
  const list = await listAiActionRequests({ orgId });
  assert.equal(list.length, 1, "only one row should exist despite two proposals");
});

test("reviewAiAction: approve sets unlockAt ~36h out; a second approve attempt is rejected (replay safety)", async () => {
  const orgId = newOrgId();
  const targetRecordId = new ObjectId();
  const { request } = await proposeAiAction({
    orgId, assistantSurface: "business", toolName: "propose_expense_decision",
    targetRecordType: "EXPENSE", targetRecordId, proposedAction: "approve",
    args: { expenseId: targetRecordId.toString(), action: "approve" },
    requestedContextSummary: "test", actorEmail: email("d"), canPropose: true,
  });

  const approved = await reviewAiAction({ orgId, requestId: request._id, decision: "approve", actorEmail: email("d-approver"), canApprove: true });
  assert.equal(approved.request.status, "APPROVED");
  const unlockMs = new Date(approved.request.unlockAt).getTime() - Date.now();
  assert.ok(unlockMs > 35.9 * 3600 * 1000 && unlockMs < 36.1 * 3600 * 1000, "unlockAt should be ~36h out");

  const replay = await reviewAiAction({ orgId, requestId: request._id, decision: "approve", actorEmail: email("d-approver"), canApprove: true });
  assert.equal(replay.status, 409, "an already-approved request cannot be approved again");
});

test("cancelAiAction: succeeds before unlockAt, fails once unlockAt has passed", async () => {
  const orgId = newOrgId();
  const { aiActionRequests } = collections;
  const targetRecordId = new ObjectId();

  const { request } = await proposeAiAction({
    orgId, assistantSurface: "business", toolName: "propose_task_status_change",
    targetRecordType: "TASK", targetRecordId, proposedAction: "start",
    args: { taskId: targetRecordId.toString(), action: "start" },
    requestedContextSummary: "test", actorEmail: email("e"), canPropose: true,
  });
  await reviewAiAction({ orgId, requestId: request._id, decision: "approve", actorEmail: email("e-approver"), canApprove: true });

  const cancelled = await cancelAiAction({ orgId, requestId: request._id, actorEmail: email("e"), canCancel: true });
  assert.equal(cancelled.request.status, "CANCELLED");

  // A second request, but simulate its unlockAt already having passed —
  // cancellation must fail once the cron may already be executing it.
  const { request: request2 } = await proposeAiAction({
    orgId, assistantSurface: "business", toolName: "propose_task_status_change",
    targetRecordType: "TASK", targetRecordId: new ObjectId(), proposedAction: "start",
    args: { taskId: new ObjectId().toString(), action: "start" },
    requestedContextSummary: "test", actorEmail: email("f"), canPropose: true,
  });
  await reviewAiAction({ orgId, requestId: request2._id, decision: "approve", actorEmail: email("f-approver"), canApprove: true });
  await aiActionRequests.updateOne({ _id: request2._id }, { $set: { unlockAt: new Date(Date.now() - 1000).toISOString() } });

  const lateCancel = await cancelAiAction({ orgId, requestId: request2._id, actorEmail: email("f"), canCancel: true });
  assert.equal(lateCancel.status, 409, "cannot cancel once unlockAt has passed");
});

test("executeApprovedAiActions: atomic claim is replay-safe under concurrent invocation (exactly one execution)", async () => {
  const orgId = newOrgId();
  const { aiActionRequests } = collections;
  const targetRecordId = new ObjectId();

  const { request } = await proposeAiAction({
    orgId, assistantSurface: "business", toolName: "propose_task_status_change",
    targetRecordType: "TASK", targetRecordId, proposedAction: "start",
    args: { taskId: targetRecordId.toString(), action: "start" },
    requestedContextSummary: "test", actorEmail: email("g"), canPropose: true,
  });
  await reviewAiAction({ orgId, requestId: request._id, decision: "approve", actorEmail: email("g-approver"), canApprove: true });
  // Force it due now, same technique as cancelAiAction's late-cancel test above.
  await aiActionRequests.updateOne({ _id: request._id }, { $set: { unlockAt: new Date(Date.now() - 1000).toISOString() } });

  // targetRecordId doesn't correspond to a real task, so the executor call
  // itself will error (task not found) and the request lands on EXPIRED —
  // that's fine, this test only cares that exactly ONE of the two
  // concurrent sweeps claims it, not what the real transition result is.
  const [resultA, resultB] = await Promise.all([
    executeApprovedAiActions({ orgId }),
    executeApprovedAiActions({ orgId }),
  ]);

  const totalClaimed = resultA.claimed + resultB.claimed;
  assert.equal(totalClaimed, 1, "exactly one concurrent sweep should have claimed the request");

  const final = await aiActionRequests.findOne({ _id: request._id });
  assert.ok(["EXECUTED", "EXPIRED"].includes(final.status));
});

test("expireStalePendingActions: flips only PENDING_APPROVAL rows past their proposalExpiresAt", async () => {
  const orgId = newOrgId();
  const { aiActionRequests } = collections;

  const { request: staleReq } = await proposeAiAction({
    orgId, assistantSurface: "business", toolName: "propose_task_status_change",
    targetRecordType: "TASK", targetRecordId: new ObjectId(), proposedAction: "start",
    args: { taskId: new ObjectId().toString(), action: "start" },
    requestedContextSummary: "stale", actorEmail: email("h"), canPropose: true,
  });
  await aiActionRequests.updateOne({ _id: staleReq._id }, { $set: { proposalExpiresAt: new Date(Date.now() - 1000).toISOString() } });

  const { request: freshReq } = await proposeAiAction({
    orgId, assistantSurface: "business", toolName: "propose_task_status_change",
    targetRecordType: "TASK", targetRecordId: new ObjectId(), proposedAction: "start",
    args: { taskId: new ObjectId().toString(), action: "start" },
    requestedContextSummary: "fresh", actorEmail: email("i"), canPropose: true,
  });

  const result = await expireStalePendingActions({ orgId });
  assert.equal(result.expired, 1);

  const stale = await aiActionRequests.findOne({ _id: staleReq._id });
  const fresh = await aiActionRequests.findOne({ _id: freshReq._id });
  assert.equal(stale.status, "EXPIRED");
  assert.equal(fresh.status, "PENDING_APPROVAL");
});
