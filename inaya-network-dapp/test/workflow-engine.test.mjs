// AI Business Operations Manager -- engine + lifecycle integration tests (real MongoDB).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setup, teardown, makeWfOrg, c } from "./_wf-fixtures.mjs";
import * as svc from "../src/lib/workflows/service.js";
import { processQueue } from "../src/lib/workflows/queue.js";
import { verifyWorkflowEvidence } from "../src/lib/workflows/evidence.js";

let org;
before(async () => { await setup(); org = await makeWfOrg("eng"); });
after(async () => { await teardown(); });

const N = (key, type, config = {}, extra = {}) => ({ key, type, name: key, config, position: { x: 0, y: 0 }, ...extra });
const def = (nodes, edges, scopes = []) => ({ nodes, edges, settings: { dataScopes: scopes, retry: { maxAttempts: 3, baseDelayMs: 10 } } });
const ctx = (who) => ({ orgId: org.oid, membership: org[who].membership, actorEmail: org[who].email, email: org[who].email });

test("a simple workflow: draft -> validate -> publish -> execute -> inspect", async () => {
  const cr = await svc.createWorkflow({ ...ctx("owner"), name: "Overdue tasks check", definition: def([
    N("t", "trigger.manual"), N("tasks", "data.employee_tasks", { limit: 50 }), N("chk", "condition.if", { expression: "nodes.tasks.output.overdueCount > 5" }),
    N("alert", "notify.inaya", { title: "Overdue tasks: {{ nodes.tasks.output.overdueCount }}", body: "Too many overdue tasks", severity: "warning", audience: "managers", alertType: "overdue" }),
  ], [{ from: "t", to: "tasks" }, { from: "tasks", to: "chk" }, { from: "chk", to: "alert", fromPort: "true" }], ["tasks", "notify"]) });
  assert.ok(!cr.error, cr.error);
  const pub = await svc.publishWorkflow({ ...ctx("owner"), id: cr.workflow.workflowId });
  assert.ok(!pub.error, JSON.stringify(pub));
  assert.equal(pub.version, 1);
  const run = await svc.executeWorkflow({ ...ctx("owner"), id: cr.workflow.workflowId });
  assert.ok(!run.error, JSON.stringify(run));
  assert.equal(run.execution.status, "COMPLETED", JSON.stringify(run.execution.errors));
  assert.equal(run.execution.summary.branch, "yes");
  assert.equal(run.execution.nodeResults.tasks.output.overdueCount, 13);
  assert.equal(run.execution.nodeResults.alert.output.delivered, 1);
  const v = await verifyWorkflowEvidence({ orgId: org.oid, executionId: run.execution.executionId });
  assert.equal(v.verified, true, JSON.stringify(v.problems));
  assert.ok(v.rowsChecked >= 5);
});
