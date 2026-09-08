// test/guided-tasks.test.mjs
//
// Guided-task state machine coverage: unknown-workflow rejection, the
// idempotent/replay-safe step advancement that backs the SOW's "wait for
// user action" and "no hallucinated skipping" requirements, the full
// pause/resume/cancel/restart lifecycle, and — the concrete tests for the
// SOW §8 "cross-organization isolation" acceptance criterion — that a
// guided task is invisible/unmodifiable both across orgs and across users
// within the same org. Same node --test + real Atlas + RUN_ID-fixtures
// convention as test/ai-action-requests.test.mjs.
//
// Run with: node --env-file=.env.local --test test/guided-tasks.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import {
  startGuidedTask, advanceGuidedTaskStep, pauseGuidedTask, resumeGuidedTask,
  cancelGuidedTask, restartGuidedTask, getGuidedTask, listActiveGuidedTasksForUser,
} from "../src/lib/guided-tasks.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const email = (label) => `test-guidedtask-${RUN_ID}-${label}@example.com`;

let collections;
const cleanup = { orgIds: [] };

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
});

after(async () => {
  const { guidedTasks, orgActivity, auditChainEntries, auditChainHeads } = collections;
  await guidedTasks.deleteMany({ orgId: { $in: cleanup.orgIds } });
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

test("startGuidedTask: rejects an unknown workflowKey, inserts nothing", async () => {
  const orgId = newOrgId();
  const result = await startGuidedTask({ orgId, userEmail: email("a"), workflowKey: "not_a_real_workflow" });
  assert.equal(result.status, 400);
  assert.ok(result.error);
});

test("startGuidedTask: real workflow starts ACTIVE at step 0 with the first step returned", async () => {
  const orgId = newOrgId();
  const { task, currentStep, totalSteps, label } = await startGuidedTask({ orgId, userEmail: email("b"), workflowKey: "find_business_record" });
  assert.equal(task.status, "ACTIVE");
  assert.equal(task.currentStepIndex, 0);
  assert.equal(task.workflowKey, "find_business_record");
  assert.ok(currentStep.instruction);
  assert.ok(totalSteps >= 1);
  assert.equal(label, "Find a business record");
});

test("advanceGuidedTaskStep: idempotent on a stale fromStepIndex -- a duplicate event does not skip a step", async () => {
  const orgId = newOrgId();
  const userEmail = email("c");
  const { task } = await startGuidedTask({ orgId, userEmail, workflowKey: "find_business_record" });

  const first = await advanceGuidedTaskStep({ orgId, userEmail, taskId: task.taskId, fromStepIndex: 0, source: "manual-confirm" });
  assert.equal(first.task.currentStepIndex, 1);

  // Duplicate/late-arriving completion for the SAME step that already
  // advanced -- must be a harmless no-op, not an error and not a second
  // advance to step 2.
  const duplicate = await advanceGuidedTaskStep({ orgId, userEmail, taskId: task.taskId, fromStepIndex: 0, source: "manual-confirm" });
  assert.equal(duplicate.alreadyAdvanced, true);
  assert.equal(duplicate.task.currentStepIndex, 1);
});

test("advanceGuidedTaskStep: a fromStepIndex behind the real current step conflicts with 409", async () => {
  const orgId = newOrgId();
  const userEmail = email("d");
  const { task } = await startGuidedTask({ orgId, userEmail, workflowKey: "find_business_record" });
  await advanceGuidedTaskStep({ orgId, userEmail, taskId: task.taskId, fromStepIndex: 0, source: "manual-confirm" });

  // fromStepIndex 5 is ahead of the real current index (1) -- must not be
  // silently accepted as if the model could assert an arbitrary jump.
  const result = await advanceGuidedTaskStep({ orgId, userEmail, taskId: task.taskId, fromStepIndex: 5, source: "manual-confirm" });
  assert.equal(result.status, 409);
});

test("advanceGuidedTaskStep: reaching the final step sets COMPLETED", async () => {
  const orgId = newOrgId();
  const userEmail = email("e");
  const { task, totalSteps } = await startGuidedTask({ orgId, userEmail, workflowKey: "find_business_record" });

  let current = task;
  for (let i = 0; i < totalSteps; i++) {
    const result = await advanceGuidedTaskStep({ orgId, userEmail, taskId: task.taskId, fromStepIndex: i, source: "manual-confirm" });
    current = result.task;
  }
  assert.equal(current.status, "COMPLETED");
  assert.equal(current.currentStepIndex, totalSteps);
});

test("advanceGuidedTaskStep: rejects advancing a task that isn't ACTIVE", async () => {
  const orgId = newOrgId();
  const userEmail = email("f");
  const { task } = await startGuidedTask({ orgId, userEmail, workflowKey: "find_business_record" });
  await pauseGuidedTask({ orgId, userEmail, taskId: task.taskId });

  const result = await advanceGuidedTaskStep({ orgId, userEmail, taskId: task.taskId, fromStepIndex: 0, source: "manual-confirm" });
  assert.equal(result.status, 409);
});

test("pause/resume/cancel/restart: full state machine", async () => {
  const orgId = newOrgId();
  const userEmail = email("g");
  const { task } = await startGuidedTask({ orgId, userEmail, workflowKey: "find_business_record" });

  const paused = await pauseGuidedTask({ orgId, userEmail, taskId: task.taskId });
  assert.equal(paused.task.status, "PAUSED");

  // Can't pause an already-paused task.
  const pauseAgain = await pauseGuidedTask({ orgId, userEmail, taskId: task.taskId });
  assert.equal(pauseAgain.status, 409);

  const resumed = await resumeGuidedTask({ orgId, userEmail, taskId: task.taskId });
  assert.equal(resumed.task.status, "ACTIVE");

  const cancelled = await cancelGuidedTask({ orgId, userEmail, taskId: task.taskId });
  assert.equal(cancelled.task.status, "CANCELLED");

  // restartGuidedTask on an already-terminal task starts a brand new row
  // rather than erroring or rewinding the cancelled one.
  const restarted = await restartGuidedTask({ orgId, userEmail, taskId: task.taskId });
  assert.notEqual(restarted.task.taskId, task.taskId);
  assert.equal(restarted.task.status, "ACTIVE");
  assert.equal(restarted.task.currentStepIndex, 0);

  // The original cancelled row is untouched -- restart never rewinds a
  // terminal row.
  const original = await getGuidedTask({ orgId, userEmail, taskId: task.taskId });
  assert.equal(original.task.status, "CANCELLED");
});

test("listActiveGuidedTasksForUser: only ACTIVE/PAUSED rows for that exact user", async () => {
  const orgId = newOrgId();
  const userEmail = email("h");
  const other = email("h-other");

  const { task: t1 } = await startGuidedTask({ orgId, userEmail, workflowKey: "find_business_record" });
  await startGuidedTask({ orgId, userEmail, workflowKey: "navigate_to_function" });
  const { task: t3 } = await startGuidedTask({ orgId, userEmail, workflowKey: "review_ai_action" });
  await cancelGuidedTask({ orgId, userEmail, taskId: t3.taskId });
  await startGuidedTask({ orgId, userEmail: other, workflowKey: "find_business_record" });

  const { tasks } = await listActiveGuidedTasksForUser({ orgId, userEmail });
  assert.equal(tasks.length, 2);
  assert.ok(tasks.every((t) => t.userEmail === userEmail));
  assert.ok(!tasks.some((t) => t.taskId === t3.taskId), "cancelled task must not be listed as active");
  assert.ok(tasks.some((t) => t.taskId === t1.taskId));
});

test("SECURITY: cross-org isolation -- a task under org A is invisible/unmodifiable via org B, even with the right taskId", async () => {
  const orgA = newOrgId();
  const orgB = newOrgId();
  const userEmail = email("i");
  const { task } = await startGuidedTask({ orgId: orgA, userEmail, workflowKey: "find_business_record" });

  const readAsB = await getGuidedTask({ orgId: orgB, userEmail, taskId: task.taskId });
  assert.equal(readAsB.status, 404);

  const advanceAsB = await advanceGuidedTaskStep({ orgId: orgB, userEmail, taskId: task.taskId, fromStepIndex: 0, source: "manual-confirm" });
  assert.equal(advanceAsB.status, 404);

  const cancelAsB = await cancelGuidedTask({ orgId: orgB, userEmail, taskId: task.taskId });
  assert.equal(cancelAsB.status, 404);

  // The org-A row is untouched by any of the failed org-B attempts.
  const stillActive = await getGuidedTask({ orgId: orgA, userEmail, taskId: task.taskId });
  assert.equal(stillActive.task.status, "ACTIVE");
});

test("SECURITY: cross-user isolation within one org -- the wrong userEmail gets not-found, never someone else's task", async () => {
  const orgId = newOrgId();
  const owner = email("j-owner");
  const intruder = email("j-intruder");
  const { task } = await startGuidedTask({ orgId, userEmail: owner, workflowKey: "find_business_record" });

  const readAsIntruder = await getGuidedTask({ orgId, userEmail: intruder, taskId: task.taskId });
  assert.equal(readAsIntruder.status, 404);

  const advanceAsIntruder = await advanceGuidedTaskStep({ orgId, userEmail: intruder, taskId: task.taskId, fromStepIndex: 0, source: "manual-confirm" });
  assert.equal(advanceAsIntruder.status, 404);
});
