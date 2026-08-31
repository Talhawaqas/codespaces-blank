// test/guarded-execution.test.mjs
//
// Phase 3 (Guarded Execution Architecture) coverage: propose -> approve
// (sets a 36h unlockAt) -> cancel-before-unlock; reject; idempotency
// (duplicate proposal within the same hour dedupes); unauthorized
// propose/approve is rejected. Phase 4 will extend this file with the
// cron executor's propose->approve->delay->execute happy path and
// replay-after-execution coverage, once the real transitionX() call site
// exists — this file covers everything the state machine itself
// guarantees today. Same node --test + real Atlas + RUN_ID-fixtures
// convention as every other test file here.
//
// Run with: node --env-file=.env.local --test test/guarded-execution.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { proposeAiAction, reviewAiAction, cancelAiAction, listAiActionRequests, SETTLEMENT_DELAY_MS } from "../src/lib/ai-action-requests.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const email = (label) => `test-guarded-${RUN_ID}-${label}@example.com`;

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

test("propose -> approve: request moves PENDING_APPROVAL -> APPROVED with unlockAt ~36h out", async () => {
  const orgId = newOrgId();
  const targetRecordId = new ObjectId();

  const { request } = await proposeAiAction({
    orgId, assistantSurface: "business", toolName: "propose_task_status_change",
    targetRecordType: "TASK", targetRecordId, proposedAction: "complete", args: { taskId: targetRecordId.toString() },
    actorEmail: email("assistant"), canPropose: true,
  });
  assert.equal(request.status, "PENDING_APPROVAL");
  assert.equal(request.unlockAt, null);

  const { request: approved } = await reviewAiAction({ orgId, requestId: request._id, decision: "approve", actorEmail: email("manager"), canApprove: true });
  assert.equal(approved.status, "APPROVED");
  const unlockDelta = new Date(approved.unlockAt).getTime() - Date.now();
  assert.ok(Math.abs(unlockDelta - SETTLEMENT_DELAY_MS) < 5000, `unlockAt should be ~36h out, was ${unlockDelta}ms`);
});

test("propose -> reject: request moves PENDING_APPROVAL -> REJECTED, no unlockAt", async () => {
  const orgId = newOrgId();
  const { request } = await proposeAiAction({
    orgId, assistantSurface: "business", toolName: "propose_expense_decision",
    targetRecordType: "EXPENSE", targetRecordId: new ObjectId(), proposedAction: "approve", args: {},
    actorEmail: email("assistant"), canPropose: true,
  });
  const { request: rejected } = await reviewAiAction({ orgId, requestId: request._id, decision: "reject", actorEmail: email("manager"), note: "not enough context", canApprove: true });
  assert.equal(rejected.status, "REJECTED");
  assert.equal(rejected.unlockAt, null);
  assert.equal(rejected.reviewNote, "not enough context");
});

test("cancel: an APPROVED request can be cancelled before unlockAt passes", async () => {
  const orgId = newOrgId();
  const { request } = await proposeAiAction({
    orgId, assistantSurface: "business", toolName: "propose_task_status_change",
    targetRecordType: "TASK", targetRecordId: new ObjectId(), proposedAction: "cancel", args: {},
    actorEmail: email("assistant"), canPropose: true,
  });
  await reviewAiAction({ orgId, requestId: request._id, decision: "approve", actorEmail: email("manager"), canApprove: true });

  const { request: cancelled } = await cancelAiAction({ orgId, requestId: request._id, actorEmail: email("manager"), canCancel: true });
  assert.equal(cancelled.status, "CANCELLED");
});

test("cancel: cannot cancel a request that is still PENDING_APPROVAL (never approved)", async () => {
  const orgId = newOrgId();
  const { request } = await proposeAiAction({
    orgId, assistantSurface: "business", toolName: "propose_task_status_change",
    targetRecordType: "TASK", targetRecordId: new ObjectId(), proposedAction: "start", args: {},
    actorEmail: email("assistant"), canPropose: true,
  });
  const result = await cancelAiAction({ orgId, requestId: request._id, actorEmail: email("manager"), canCancel: true });
  assert.equal(result.error !== undefined, true);
  assert.equal(result.status, 409);
});

test("unauthorized: proposeAiAction rejects when canPropose is false", async () => {
  const orgId = newOrgId();
  const result = await proposeAiAction({
    orgId, assistantSurface: "business", toolName: "propose_expense_decision",
    targetRecordType: "EXPENSE", targetRecordId: new ObjectId(), proposedAction: "approve", args: {},
    actorEmail: email("outsider"), canPropose: false,
  });
  assert.equal(result.error !== undefined, true);
  assert.equal(result.status, 403);
});

test("unauthorized: reviewAiAction rejects when canApprove is false, request stays pending", async () => {
  const orgId = newOrgId();
  const { request } = await proposeAiAction({
    orgId, assistantSurface: "business", toolName: "propose_expense_decision",
    targetRecordType: "EXPENSE", targetRecordId: new ObjectId(), proposedAction: "approve", args: {},
    actorEmail: email("assistant"), canPropose: true,
  });
  const result = await reviewAiAction({ orgId, requestId: request._id, decision: "approve", actorEmail: email("staff-not-manager"), canApprove: false });
  assert.equal(result.error !== undefined, true);
  assert.equal(result.status, 403);

  const [stillPending] = await listAiActionRequests({ orgId, status: "PENDING_APPROVAL" });
  assert.equal(stillPending._id.toString(), request._id.toString());
});

test("idempotency: an identical proposal within the same hour dedupes to the existing request", async () => {
  const orgId = newOrgId();
  const targetRecordId = new ObjectId();
  const args = { note: "same args" };

  const { request: first } = await proposeAiAction({
    orgId, assistantSurface: "business", toolName: "propose_task_status_change",
    targetRecordType: "TASK", targetRecordId, proposedAction: "complete", args,
    actorEmail: email("assistant"), canPropose: true,
  });
  const { request: second, deduped } = await proposeAiAction({
    orgId, assistantSurface: "business", toolName: "propose_task_status_change",
    targetRecordType: "TASK", targetRecordId, proposedAction: "complete", args,
    actorEmail: email("assistant"), canPropose: true,
  });
  assert.equal(deduped, true);
  assert.equal(second._id.toString(), first._id.toString());

  const all = await listAiActionRequests({ orgId });
  assert.equal(all.length, 1);
});

test("replay: reviewing an already-reviewed request fails cleanly (no double-approval)", async () => {
  const orgId = newOrgId();
  const { request } = await proposeAiAction({
    orgId, assistantSurface: "business", toolName: "propose_task_status_change",
    targetRecordType: "TASK", targetRecordId: new ObjectId(), proposedAction: "start", args: {},
    actorEmail: email("assistant"), canPropose: true,
  });
  const first = await reviewAiAction({ orgId, requestId: request._id, decision: "approve", actorEmail: email("manager"), canApprove: true });
  assert.equal(first.request.status, "APPROVED");

  const replay = await reviewAiAction({ orgId, requestId: request._id, decision: "reject", actorEmail: email("manager"), canApprove: true });
  assert.equal(replay.error !== undefined, true);
  assert.equal(replay.status, 409);
});
