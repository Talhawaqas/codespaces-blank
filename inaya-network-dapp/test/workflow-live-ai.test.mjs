// AI Business Operations Manager -- LIVE Gemini check (SOW §14, acceptance criterion 6 "Gemini produces
// structured output"). This test calls the REAL Gemini model through the server-side integration. It uses
// synthetic (test-mode) business data so nothing real is sent to the model, and it is skipped when no
// GEMINI_API_KEY is configured. Run: node --import ./test/_next-loader.mjs --env-file=.env.local --test test/workflow-live-ai.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setup, teardown, makeWfOrg, N, E, wfDef } from "./_wf-fixtures.mjs";
import * as svc from "../src/lib/workflows/service.js";
import { draftWorkflowFromPrompt } from "../src/lib/workflows/copilot.js";
import { __setAiProvider } from "../src/lib/workflows/ai.js";

const HAS_KEY = !!process.env.GEMINI_API_KEY;
let org;
const O = () => ({ orgId: org.oid, membership: org.owner.membership, actorEmail: org.owner.email, email: org.owner.email });
const J = (x) => JSON.stringify(x);

before(async () => { __setAiProvider(null); await setup(); org = await makeWfOrg("live"); });
after(async () => { await teardown(); });

test("real Gemini returns a schema-valid, sensible structured assessment for synthetic data", { skip: !HAS_KEY && "GEMINI_API_KEY is not configured" }, async () => {
  const cr = await svc.createWorkflow({ ...O(), name: "Live AI check", definition: wfDef([
    N("t", "trigger.manual"), N("inv", "data.overdue_invoices", {}), N("kpi", "kpi.snapshot", { periodDays: 30 }),
    N("agent", "ai.agent", { maxToolCalls: 2, tools: ["read_invoices"], inputFrom: ["kpi"], thresholds: [{ name: "Overdue over 10k", expression: "nodes.kpi.output.snapshot.overdueInvoices.total", op: ">", value: 10000 }], systemInstructions: "Be brief." }),
    N("c", "condition.if", { expression: "nodes.agent.output.result.urgent == true or nodes.agent.output.deterministic.anyExceeded == true" }),
    N("note", "evidence.record", { note: "urgent path taken" }),
  ], [E("t", "inv"), E("inv", "kpi"), E("kpi", "agent"), E("agent", "c"), E("c", "note", "true")], ["finance", "insights", "ai", "evidence"], { aiTimeoutMs: 90000 }) });
  assert.ok(!cr.error, cr.error);
  const urgent = { nodes: { inv: { invoices: [{ invoiceNumber: "INV-1", total: 48000, daysOverdue: 62, contactName: "Acme" }, { invoiceNumber: "INV-2", total: 9000, daysOverdue: 35, contactName: "Initech" }], count: 2, totalOverdue: 57000, over10k: 1 } } };
  const r = await svc.testWorkflow({ ...O(), id: cr.workflow.workflowId, testData: urgent });
  assert.ok(r.execution, `test run was refused: ${J(r)}`);
  assert.equal(r.execution.status, "COMPLETED", J(r.execution.errors) + J(Object.entries(r.execution.nodeResults).filter(([, x]) => x.status === "FAILED")));
  const a = r.execution.nodeResults.agent.output;
  assert.ok(a.model.startsWith("gemini"), "a real Gemini model answered");
  assert.ok(["normal", "attention", "urgent", "critical"].includes(a.result.classification));
  assert.equal(typeof a.result.urgent, "boolean");
  assert.ok(a.result.confidence >= 0 && a.result.confidence <= 1);
  assert.ok(a.result.summary.length > 10);
  assert.ok(a.deterministic.anyExceeded, "the deterministic threshold fact was computed by the engine");
  assert.equal(r.execution.nodeResults.c.output.branch, "true", "condition routes on the structured result");
  assert.ok(a.latencyMs > 0);
  console.log(`# live Gemini: ${a.model}, ${a.latencyMs} ms, classification=${a.result.classification}, urgent=${a.result.urgent}, confidence=${a.result.confidence}`);
});

test("real Gemini copilot drafts a valid workflow from a sentence, and does not publish it", { skip: !HAS_KEY && "GEMINI_API_KEY is not configured" }, async () => {
  const r = await draftWorkflowFromPrompt({ ...O(), prompt: "Every weekday at 8 AM, check overdue invoices above $10,000, and if any exist send a notification to the managers." });
  assert.ok(!r.error, J(r));
  assert.equal(r.published, false); assert.equal(r.workflow.status, "DRAFT");
  console.log(`# live copilot: ${r.draft.nodes.length} nodes, valid=${r.review.valid}, risk=${r.review.riskLevel}, problems=${J(r.review.problems)}`);
  assert.ok(r.draft.nodes.some((n) => n.type.startsWith("trigger.")) && r.draft.nodes.some((n) => n.type === "data.overdue_invoices"));
  assert.ok(r.review.valid, `the draft should validate: ${J(r.review.problems)}`);
});
