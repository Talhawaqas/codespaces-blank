// src/lib/workflows/evaluations.js
//
// SOW §24, §25: workflow evaluations. An evaluation is a set of cases, each a
// synthetic (or sanitized) dataset plus the outcome the owner expects. Running it
// executes the workflow in TEST mode only: synthetic data, no notification sent,
// no approval request created, nothing written to business records. Test runs are
// recorded separately from production executions (mode = "test").
//
// A case can check: final status, which branch a condition took, the AI
// classification / urgency, which tools the agent used, how many notifications
// WOULD have gone out, the failed node (for failure-handling cases), retries and
// latency. Cases may inject faults (a node that fails or times out N times) to
// exercise retry and failure handling without touching anything real.

import { getOrgCollections, toObjectId } from "../orgs.js";
import { executeWorkflow, loadWorkflow, can } from "./service.js";
import { recordWorkflowEvidence } from "./evidence.js";
import { fail } from "./common.js";

const MAX_CASES = 20;

export async function createEvaluation({ orgId, workflowId, name, cases, membership, actorEmail }) {
  const w = await loadWorkflow(orgId, workflowId);
  if (!w || !can(w, membership, actorEmail, "view")) return fail("Workflow not found.", 404);
  if (!can(w, membership, actorEmail, "edit")) return fail("You don't have permission to edit evaluations for this workflow.", 403);
  if (!name || String(name).length > 80) return fail("A name (up to 80 characters) is required.");
  if (!Array.isArray(cases) || !cases.length || cases.length > MAX_CASES) return fail(`Provide 1–${MAX_CASES} cases.`);
  for (const c of cases) {
    if (!c?.name) return fail("Each case needs a name.");
    if (JSON.stringify(c).length > 60_000) return fail(`Case "${c.name}" is too large.`, 413);
  }
  const { workflowEvaluations } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = { orgId: toObjectId(orgId), workflowId: w._id, name: String(name), cases: JSON.parse(JSON.stringify(cases)), createdBy: actorEmail, createdAt: now, updatedAt: now, runs: [] };
  const r = await workflowEvaluations.insertOne(doc);
  return { evaluationId: String(r.insertedId), cases: cases.length };
}

export async function listEvaluations({ orgId, workflowId, membership, email }) {
  const w = await loadWorkflow(orgId, workflowId);
  if (!w || !can(w, membership, email, "view")) return fail("Workflow not found.", 404);
  const { workflowEvaluations } = await getOrgCollections();
  const rows = await workflowEvaluations.find({ orgId: toObjectId(orgId), workflowId: w._id }).sort({ createdAt: -1 }).limit(50).toArray();
  return { evaluations: rows.map((r) => ({ evaluationId: String(r._id), name: r.name, cases: r.cases.length, createdAt: r.createdAt, lastRun: r.runs?.[0] ? { at: r.runs[0].at, passed: r.runs[0].passed, total: r.runs[0].total, passRate: r.runs[0].passRate } : null })) };
}

export async function getEvaluation({ orgId, evaluationId, membership, email }) {
  const { workflowEvaluations } = await getOrgCollections();
  let ev; try { ev = await workflowEvaluations.findOne({ _id: toObjectId(evaluationId), orgId: toObjectId(orgId) }); } catch { ev = null; }
  if (!ev) return fail("Evaluation not found.", 404);
  const w = await loadWorkflow(orgId, ev.workflowId);
  if (!w || !can(w, membership, email, "view")) return fail("Evaluation not found.", 404);
  return { evaluation: { evaluationId: String(ev._id), workflowId: String(ev.workflowId), name: ev.name, cases: ev.cases, runs: ev.runs || [] } };
}

const outcome = (exec) => {
  const nr = exec.nodeResults || {};
  const conditions = Object.entries(nr).filter(([, r]) => r.type === "condition.if" && r.status === "COMPLETED");
  const ai = Object.values(nr).find((r) => r.type === "ai.agent" && r.status === "COMPLETED");
  const notify = Object.entries(nr).filter(([, r]) => r.type?.startsWith("notify.") && r.status === "COMPLETED").map(([k, r]) => ({ node: k, wouldSend: r.output?.wouldSend || null }));
  return {
    status: exec.status, branch: exec.summary?.branch || null, branches: Object.fromEntries(conditions.map(([k, r]) => [k, r.output?.branch])),
    aiClassification: ai?.output?.result?.classification || null, aiUrgent: ai?.output?.result?.urgent ?? null, aiConfidence: ai?.output?.result?.confidence ?? null,
    toolsCalled: (ai?.output?.explainability?.toolCalls || []).filter((t) => t.decision === "ALLOWED" || t.decision === "SIMULATED" || t.decision === "SYNTHETIC").map((t) => t.tool),
    notificationNodes: notify.map((x) => x.node), notificationCount: notify.length,
    failedNode: exec.summary?.failedNode || Object.entries(nr).find(([, r]) => r.status === "FAILED")?.[0] || null,
    nodesCompleted: Object.values(nr).filter((r) => r.status === "COMPLETED").length, nodesSkipped: Object.entries(nr).filter(([, r]) => r.status === "SKIPPED").map(([k]) => k),
    retries: Object.values(nr).reduce((a, r) => a + (r.retryCount || 0), 0), latencyMs: exec.durationMs ?? null,
  };
};

function check(name, expected, actual, cmp = (a, b) => JSON.stringify(a) === JSON.stringify(b)) { return { name, expected, actual, passed: cmp(expected, actual) }; }

export function compareOutcome(expect = {}, got) {
  const checks = [];
  if (expect.status !== undefined) checks.push(check("final status", expect.status, got.status));
  if (expect.branch !== undefined) checks.push(check("branch taken", expect.branch, got.branch));
  for (const [node, want] of Object.entries(expect.branches || {})) checks.push(check(`condition ${node}`, want, got.branches[node]));
  if (expect.aiClassification !== undefined) checks.push(check("AI classification", expect.aiClassification, got.aiClassification));
  if (expect.aiUrgent !== undefined) checks.push(check("AI urgent", expect.aiUrgent, got.aiUrgent));
  if (expect.toolsCalled !== undefined) checks.push(check("tools used", [...expect.toolsCalled].sort(), [...got.toolsCalled].sort()));
  if (expect.notificationNodes !== undefined) checks.push(check("notifications that would fire", [...expect.notificationNodes].sort(), [...got.notificationNodes].sort()));
  if (expect.notificationCount !== undefined) checks.push(check("notification count", expect.notificationCount, got.notificationCount));
  if (expect.failedNode !== undefined) checks.push(check("failed node", expect.failedNode, got.failedNode));
  if (expect.retriesAtLeast !== undefined) checks.push(check("retries", `>= ${expect.retriesAtLeast}`, got.retries, () => got.retries >= expect.retriesAtLeast));
  if (expect.maxLatencyMs !== undefined) checks.push(check("latency", `<= ${expect.maxLatencyMs} ms`, got.latencyMs, () => got.latencyMs !== null && got.latencyMs <= expect.maxLatencyMs));
  if (expect.skipped !== undefined) checks.push(check("skipped nodes", [...expect.skipped].sort(), [...got.nodesSkipped].sort()));
  return checks;
}

export async function runEvaluation({ orgId, evaluationId, membership, actorEmail, useDraft = false }) {
  const { workflowEvaluations } = await getOrgCollections();
  let ev; try { ev = await workflowEvaluations.findOne({ _id: toObjectId(evaluationId), orgId: toObjectId(orgId) }); } catch { ev = null; }
  if (!ev) return fail("Evaluation not found.", 404);
  const w = await loadWorkflow(orgId, ev.workflowId);
  if (!w || !can(w, membership, actorEmail, "execute")) return fail("You don't have permission to run evaluations for this workflow.", 403);
  const results = [];
  for (const c of ev.cases) {
    const t0 = Date.now();
    const r = await executeWorkflow({ orgId, id: String(w._id), membership, actorEmail, mode: "test", testData: c.testData || {}, useDraft: useDraft || !w.published, wait: true });
    if (r.error) { results.push({ case: c.name, passed: false, error: r.error, checks: [] }); continue; }
    const got = outcome(r.execution);
    const checks = compareOutcome(c.expect || {}, got);
    results.push({ case: c.name, passed: checks.length > 0 && checks.every((x) => x.passed), checks, executionId: r.execution.executionId, outcome: got, wallMs: Date.now() - t0, note: "TEST MODE: synthetic data, nothing sent, nothing changed." });
  }
  const passed = results.filter((r) => r.passed).length;
  const run = { at: new Date().toISOString(), by: actorEmail, total: results.length, passed, passRate: results.length ? Math.round((passed / results.length) * 100) : 0, avgLatencyMs: results.length ? Math.round(results.reduce((a, r) => a + (r.outcome?.latencyMs || 0), 0) / results.length) : 0, results, workflowVersion: useDraft || !w.published ? "draft" : w.published.version };
  await workflowEvaluations.updateOne({ _id: ev._id }, { $set: { updatedAt: run.at }, $push: { runs: { $each: [run], $position: 0, $slice: 10 } } });
  await recordWorkflowEvidence({ orgId, workflowId: w._id, action: "EVALUATION_RUN", actorEmail, actorType: "human", mode: "test", data: { evaluationId: String(ev._id), total: run.total, passed: run.passed, passRate: run.passRate }, graph: false });
  return { run };
}
