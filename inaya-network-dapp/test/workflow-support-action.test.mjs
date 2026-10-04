// test/workflow-support-action.test.mjs -- the native support WRITE node (action.support_ticket) through the real
// workflow engine against real MongoDB: it opens a ticket / adds an internal note as the executing identity,
// never duplicates on a retry, refuses an identity without support access, and does nothing in dry_run/test.
// Run: node --env-file=.env.local --test --test-force-exit test/workflow-support-action.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setup, teardown, makeWfOrg } from "./_wf-fixtures.mjs";
import * as svc from "../src/lib/workflows/service.js";
import { validateWorkflowDefinition, NODE_TYPES } from "../src/lib/workflows/nodes.js";
import { getSupportCollections } from "../src/lib/support/db.js";
import { effectKey } from "../src/lib/workflows/effects.js";

let org; let sc;
before(async () => { await setup(); org = await makeWfOrg("sup"); sc = await getSupportCollections(); });
after(async () => {
  await sc.supportTickets.deleteMany({ orgId: org.orgId }); await sc.supportMessages.deleteMany({ orgId: org.orgId });
  await teardown();
});

const O = (who = org.owner) => ({ orgId: org.oid, membership: who.membership, actorEmail: who.email, email: who.email });
const def = (config) => ({
  nodes: [
    { key: "start", type: "trigger.manual", name: "Start", position: { x: 0, y: 0 }, config: {} },
    { key: "ticket", type: "action.support_ticket", name: "Support", position: { x: 200, y: 0 }, config },
  ],
  edges: [{ from: "start", to: "ticket" }],
  settings: { dataScopes: ["support"] },
});
async function publish(name, config, who = org.owner) {
  const made = await svc.createWorkflow({ ...O(who), name, definition: def(config) });
  assert.ok(!made.error, JSON.stringify(made));
  const id = made.workflow.workflowId;
  const pub = await svc.publishWorkflow({ ...O(who), id, note: "t" });
  assert.ok(!pub.error, JSON.stringify(pub));
  return id;
}

test("validation: operation and required fields are enforced, and the node needs the support scope", () => {
  const bad = validateWorkflowDefinition(def({ operation: "reply" }));
  assert.equal(bad.valid, false);
  assert.match(JSON.stringify(bad.errors), /operation must be create or note/);
  assert.match(JSON.stringify(validateWorkflowDefinition(def({ operation: "create", priority: "panic" })).errors), /requesterEmail is required[\s\S]*priority must be/);
  assert.match(JSON.stringify(validateWorkflowDefinition(def({ operation: "note", body: "x" })).errors), /ticketNumber/);
  assert.equal(validateWorkflowDefinition(def({ operation: "create", requesterEmail: "c@x.example", subject: "Hello there", description: "Body" })).valid, true);
  assert.equal(NODE_TYPES["action.support_ticket"].scope, "support");
  const noScope = def({ operation: "create", requesterEmail: "c@x.example", subject: "Hello there", description: "Body" }); noScope.settings.dataScopes = [];
  assert.equal(validateWorkflowDefinition(noScope).valid, false, "a workflow that uses the node must declare the support scope");
});

test("create: opens a real ticket as the run identity, with templated fields, and records it as evidence", async () => {
  const id = await publish("open ticket", { operation: "create", requesterEmail: "customer@acme.example", subject: "Overdue invoice follow-up {{ trigger.payload.ref }}", description: "Please chase this.", priority: "high", tags: ["workflow", "billing"] });
  const run = await svc.executeWorkflow({ ...O(), id, payload: { ref: "INV-77" } });
  assert.ok(!run.error, JSON.stringify(run));
  const nr = run.execution.nodeResults.ticket;
  assert.equal(run.execution.status, "COMPLETED", JSON.stringify(run.execution.errors));
  assert.equal(nr.output.created, true);
  const t = await sc.supportTickets.findOne({ orgId: org.orgId, number: nr.output.number });
  assert.ok(t, "the ticket exists in Customer Support");
  assert.match(t.subject, /INV-77/);
  assert.equal(t.priority, "HIGH");
  assert.equal(t.requester.email, "customer@acme.example");
  assert.ok(t.tags.includes("workflow"));
});

test("a retry of the same execution reuses the effect instead of opening a second ticket", async () => {
  const id = await publish("open once", { operation: "create", requesterEmail: "once@acme.example", subject: "Only once please", description: "Body" });
  const run = await svc.executeWorkflow({ ...O(), id });
  assert.equal(run.execution.status, "COMPLETED");
  assert.equal(await sc.supportTickets.countDocuments({ orgId: org.orgId, "requester.email": "once@acme.example" }), 1);
  const { getOrgCollections } = await import("../src/lib/orgs.js");
  const { workflowEffects } = await getOrgCollections();
  const key = effectKey("support_ticket", run.execution.executionId || run.execution._id, "ticket");
  const eff = await workflowEffects.findOne({ orgId: org.orgId, effectKey: key });
  assert.equal(eff?.state, "DONE");
  assert.equal(eff.result.created, true);
});

test("note: adds an INTERNAL note to an existing ticket and nothing customer-visible", async () => {
  const id1 = await publish("seed", { operation: "create", requesterEmail: "n@acme.example", subject: "Needs a note", description: "Body" });
  const seed = (await svc.executeWorkflow({ ...O(), id: id1 })).execution.nodeResults.ticket.output;
  const id2 = await publish("note", { operation: "note", ticketNumber: seed.number, body: "Escalated by automation." });
  const run = await svc.executeWorkflow({ ...O(), id: id2 });
  assert.equal(run.execution.status, "COMPLETED", JSON.stringify(run.execution.errors));
  const notes = await sc.supportMessages.find({ orgId: org.orgId, ticketId: (await sc.supportTickets.findOne({ orgId: org.orgId, number: seed.number }))._id, kind: "NOTE" }).toArray();
  assert.equal(notes.length, 1);
  assert.equal(notes[0].visibility, "INTERNAL");
  assert.match(notes[0].body, /Escalated by automation/);
});

test("an identity without support access cannot publish-and-run it, and a missing ticket fails cleanly", async () => {
  const id = await publish("nobody", { operation: "create", requesterEmail: "z@acme.example", subject: "Should not exist", description: "Body" }).catch((e) => e);
  if (typeof id === "string") {
    const run = await svc.executeWorkflow({ ...O(org.nobody), id });
    assert.ok(run.error || run.execution?.status !== "COMPLETED", "the run is refused or fails");
  }
  assert.equal(await sc.supportTickets.countDocuments({ orgId: org.orgId, "requester.email": "z@acme.example" }), 0);
  const idMissing = await publish("missing", { operation: "note", ticketNumber: "TKT-DOESNOTEXIST", body: "x" });
  const run = await svc.executeWorkflow({ ...O(), id: idMissing });
  assert.equal(run.execution.status, "FAILED");
  assert.match(JSON.stringify(run.execution.errors), /not found/i);
});

test("dry_run and test mode write nothing", async () => {
  const id = await publish("dry", { operation: "create", requesterEmail: "dry@acme.example", subject: "Dry run ticket", description: "Body" });
  const run = await svc.executeWorkflow({ ...O(), id, mode: "dry_run" });
  assert.equal(run.execution.nodeResults.ticket.output.simulated, true);
  assert.equal(await sc.supportTickets.countDocuments({ orgId: org.orgId, "requester.email": "dry@acme.example" }), 0);
});
