// test/workflow-org-switch.test.mjs -- the organization-wide automations switch, through the real engine and queue against real MongoDB:
// only owner/admin can flip it; while off, production runs (manual, schedule/event enqueue, an already-queued run) are refused but
// test and dry-run still work; turning it back on restores everything; every change is in the audit chain.
// Run: node --env-file=.env.local --test --test-force-exit test/workflow-org-switch.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setup, teardown, makeWfOrg } from "./_wf-fixtures.mjs";
import * as svc from "../src/lib/workflows/service.js";
import { getOrgAutomations, setOrgAutomations } from "../src/lib/workflows/orgSwitch.js";
import { enqueueExecution, processQueue } from "../src/lib/workflows/queue.js";
import { getOrgCollections } from "../src/lib/orgs.js";

let org, wfId;
const O = (who = org.owner) => ({ orgId: org.oid, membership: who.membership, actorEmail: who.email, email: who.email });

before(async () => {
  await setup(); org = await makeWfOrg("sw");
  const made = await svc.createWorkflow({ ...O(), name: "switch me", definition: {
    nodes: [{ key: "start", type: "trigger.manual", name: "Start", position: { x: 0, y: 0 }, config: {} }, { key: "r", type: "action.report", name: "Report", position: { x: 200, y: 0 }, config: { reportType: "daily_operations" } }],
    edges: [{ from: "start", to: "r" }], settings: { dataScopes: [] } } });
  assert.ok(!made.error, JSON.stringify(made)); wfId = made.workflow.workflowId;
  const pub = await svc.publishWorkflow({ ...O(), id: wfId, note: "t" }); assert.ok(!pub.error, JSON.stringify(pub));
});
after(async () => { await teardown(); });

test("the switch defaults to on and only the owner or an admin can change it", async () => {
  assert.equal((await getOrgAutomations({ orgId: org.oid })).enabled, true);
  const denied = await setOrgAutomations({ ...O(org.salesRep), enabled: false });
  assert.equal(denied.status, 403);
  assert.equal((await setOrgAutomations({ ...O(), enabled: "no" })).status, 400);
  assert.equal((await getOrgAutomations({ orgId: org.oid })).enabled, true, "a refused change changes nothing");
});

test("while off: a production run is refused, nothing is queued, test and dry-run still work; back on restores production", async () => {
  const off = await setOrgAutomations({ ...O(), enabled: false, reason: "investigating a bad report" });
  assert.equal(off.enabled, false); assert.equal(off.reason, "investigating a bad report"); assert.equal(off.offBy, org.owner.email);

  const { workflowExecutions } = await getOrgCollections();
  const count = () => workflowExecutions.countDocuments({ orgId: org.orgId, mode: "production" });
  const before = await count();
  const refused = await svc.executeWorkflow({ ...O(), id: wfId });
  assert.equal(refused.status, 403); assert.equal(refused.reasonCode, "AUTOMATIONS_OFF");
  assert.equal(await count(), before, "a refused run creates no production execution record");

  const dry = await svc.executeWorkflow({ ...O(), id: wfId, mode: "dry_run" });
  assert.ok(!dry.error && dry.execution.status === "COMPLETED", "dry run still works: " + JSON.stringify(dry.error || dry.execution.errors));
  const tst = await svc.testWorkflow({ ...O(), id: wfId });
  assert.ok(!tst.error, JSON.stringify(tst));

  const on = await setOrgAutomations({ ...O(), enabled: true });
  assert.equal(on.enabled, true); assert.equal(on.offSince, null);
  const run = await svc.executeWorkflow({ ...O(), id: wfId });
  assert.equal(run.execution.status, "COMPLETED", JSON.stringify(run.execution?.errors || run));
});

test("a production run already queued when the switch goes off is refused by the worker, not run", async () => {
  const { workflows, workflowExecutions } = await getOrgCollections();
  const w = await workflows.findOne({ orgId: org.orgId, name: "switch me" });
  const q = await enqueueExecution({ orgId: org.oid, workflow: w, version: w.published.version, mode: "production", trigger: { type: "schedule", source: "scheduler" }, runAs: org.owner.email, initiatingIdentity: { kind: "schedule", email: org.owner.email } });
  assert.ok(q.created, JSON.stringify(q));
  await setOrgAutomations({ ...O(), enabled: false });
  await processQueue({ max: 50 });
  const after = await workflowExecutions.findOne({ _id: q.execution._id });
  assert.equal(after.status, "FAILED");
  assert.equal(after.errors[0].code, "AUTOMATIONS_OFF");
  await setOrgAutomations({ ...O(), enabled: true });
});

test("every change is recorded in the audit chain", async () => {
  const { workflowEvidence } = await getOrgCollections();
  const rows = await workflowEvidence.find({ orgId: org.orgId, action: "ORG_AUTOMATIONS_CHANGED" }).sort({ createdAt: 1 }).toArray();
  assert.ok(rows.length >= 4, "off, on, off, on");
  assert.deepEqual(rows.slice(0, 2).map((r) => r.result), ["DISABLED", "ENABLED"]);
  assert.ok(rows[0].auditRef && rows[0].rowHash, "each row is hashed and chained to the audit chain");
});
