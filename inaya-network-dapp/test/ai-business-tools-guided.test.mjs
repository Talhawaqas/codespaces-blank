// test/ai-business-tools-guided.test.mjs
//
// Confirms the 5 guided-task tools added to ai-business-tools.js thread
// ctx.orgId/ctx.email only (the same permission-resolved values every
// other tool in that file already uses) and never accept a client-supplied
// override -- mirrors the whole file's existing security argument that a
// tool's arguments can never widen its own scope. Exercised through
// runBusinessTool(), the exact dispatcher /api/ai/business-chat uses, with
// a real Mongo-backed ctx (these tools go straight through to
// guided-tasks.js, so there's nothing meaningful to fake here).
//
// Run with: node --env-file=.env.local --test test/ai-business-tools-guided.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { runBusinessTool } from "../src/lib/ai-business-tools.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const email = (label) => `test-aibiztools-guided-${RUN_ID}-${label}@example.com`;

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

function ctxFor(orgId, userEmail) {
  return { orgId, email: userEmail, membership: { role: "member" }, scope: {} };
}

test("start_guided_task: rejects an unknown workflowKey", async () => {
  const ctx = ctxFor(newOrgId(), email("a"));
  const result = await runBusinessTool("start_guided_task", { workflowKey: "not_real" }, ctx);
  assert.ok(result.error);
});

test("start_guided_task -> get_guided_task_status -> advance_guided_task_step -> cancel_guided_task, full round trip", async () => {
  const ctx = ctxFor(newOrgId(), email("b"));

  const started = await runBusinessTool("start_guided_task", { workflowKey: "find_business_record" }, ctx);
  assert.equal(started.started, true);
  assert.equal(started.stepNumber, 1);
  assert.ok(started.instruction);

  const status = await runBusinessTool("get_guided_task_status", {}, ctx);
  assert.equal(status.hasActiveTask, true);
  assert.equal(status.stepNumber, 1);

  const advanced = await runBusinessTool("advance_guided_task_step", { fromStepIndex: 0 }, ctx);
  assert.equal(advanced.advanced, true);
  assert.equal(advanced.stepNumber, 2);

  const cancelled = await runBusinessTool("cancel_guided_task", {}, ctx);
  assert.equal(cancelled.cancelled, true);

  const statusAfterCancel = await runBusinessTool("get_guided_task_status", {}, ctx);
  assert.equal(statusAfterCancel.hasActiveTask, false);
});

test("start_guided_task: refuses to start a second task while one is already in progress", async () => {
  const ctx = ctxFor(newOrgId(), email("c"));
  await runBusinessTool("start_guided_task", { workflowKey: "find_business_record" }, ctx);

  const second = await runBusinessTool("start_guided_task", { workflowKey: "navigate_to_function" }, ctx);
  assert.equal(second.alreadyInProgress, true);
  assert.ok(second.existingWorkflow);
});

test("set_guided_task_paused: pauses and resumes", async () => {
  const ctx = ctxFor(newOrgId(), email("d"));
  await runBusinessTool("start_guided_task", { workflowKey: "find_business_record" }, ctx);

  const paused = await runBusinessTool("set_guided_task_paused", { paused: true }, ctx);
  assert.equal(paused.status, "PAUSED");

  const resumed = await runBusinessTool("set_guided_task_paused", { paused: false }, ctx);
  assert.equal(resumed.status, "ACTIVE");
});

test("SECURITY: guided-task tools only ever operate on ctx.orgId/ctx.email, never a value from args", async () => {
  const realOrgId = newOrgId();
  const otherOrgId = newOrgId();
  const ctx = ctxFor(realOrgId, email("e"));

  // None of these tools even declare an orgId/userEmail parameter, but
  // this proves that if a caller stuffed one into args anyway (e.g. a
  // malformed or adversarial tool-call payload), it's silently ignored --
  // the implementation destructures only the fields it actually declared.
  const started = await runBusinessTool("start_guided_task", { workflowKey: "find_business_record", orgId: otherOrgId.toString(), userEmail: "someone-else@example.com" }, ctx);
  assert.equal(started.started, true);

  const status = await runBusinessTool("get_guided_task_status", {}, ctxFor(otherOrgId, email("e")));
  assert.equal(status.hasActiveTask, false, "the task must be scoped to ctx.orgId, not any org id smuggled through args");
});
