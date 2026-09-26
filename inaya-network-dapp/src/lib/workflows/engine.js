// src/lib/workflows/engine.js
//
// SOW §20-§26, §39, §58: the server-side execution engine. One call runs (or
// resumes) ONE claimed execution; queue.js decides which execution that is.
//
// Guarantees, and where they live:
//   * FAIL CLOSED / no stale authority (§31, §58): the run identity's membership,
//     the organization, the workflow's enabled state, the definition hash and every
//     declared data scope are re-checked from live records at start AND before each
//     node. Nothing is trusted from the definition or from who scheduled the run.
//   * IDEMPOTENT + RESUMABLE (§21): node results are persisted after every node; a
//     resumed execution skips COMPLETED nodes and re-runs only unfinished ones.
//     Side effects claim a deterministic key first (effects.js), so a crash between
//     "did it" and "recorded it" can never duplicate an email or an approval request.
//   * CONCURRENCY-SAFE: every write is conditional on this worker still owning the
//     lease; a worker that lost its lease stops without touching the record.
//   * HONEST STATUS (§39): any failed node makes the execution FAILED (partial work is
//     labeled partial), never a quiet COMPLETED.
//   * MODES (§25, §26): production; dry_run (real read-only data, every write simulated);
//     test (synthetic data, every write simulated, recorded separately).

import { getOrgCollections, toObjectId, getMembership } from "../orgs.js";
import { canonicalHash } from "../documentAutomation/manifest.js";
import { simulateDigitalTwinScenario } from "../digitalTwinSimulate.js";
import { NODE_TYPES, scopeHeld, normalizeSettings, requiredScopes } from "./nodes.js";
import { evaluate, evaluateCondition, renderTemplate } from "./expr.js";
import * as T from "./transform.js";
import { buildDataContext, runDataNode, buildKpiSnapshot } from "./data.js";
import { runHttpRequest } from "./http.js";
import { runNotifyNode } from "./notify.js";
import { runAiAgent } from "./ai.js";
import { submitApprovalRequest } from "./tools.js";
import { claimEffect, completeEffect, effectKey } from "./effects.js";
import { recordWorkflowEvidence, linkExecutionGraphBatch, listWorkflowEvidence } from "./evidence.js";
import { buildReport } from "./reports.js";
import { redact, bounded, summarize, sleep, withTimeout, backoffMs } from "./common.js";

const LEASE_MS = 60_000;
const IN_PROCESS_BACKOFF_MS = 5000;
const MAX_PARALLEL = 4;
const RESOLVED_APPROVAL = new Set(["EXECUTED", "REJECTED", "EXPIRED", "CANCELLED"]);

class LeaseLost extends Error { constructor() { super("This worker no longer owns the execution."); this.name = "LeaseLost"; } }
class Stop extends Error { constructor(kind) { super(kind); this.kind = kind; } }

// ---------------------------------------------------------------- loading
async function loadDefinition(exec) {
  if (exec.definitionSnapshot) return { definition: exec.definitionSnapshot, definitionHash: exec.definitionHash };
  const { workflowVersions } = await getOrgCollections();
  const v = await workflowVersions.findOne({ orgId: exec.orgId, workflowId: exec.workflowId, version: exec.workflowVersion });
  if (!v) throw Object.assign(new Error("The workflow version was not found."), { code: "VERSION_MISSING", fatal: true });
  if (canonicalHash(v.definition) !== v.definitionHash) throw Object.assign(new Error("The published workflow version no longer matches its recorded hash (tampering suspected)."), { code: "DEFINITION_TAMPERED", fatal: true });
  return { definition: v.definition, definitionHash: v.definitionHash };
}

export function orgIsActive(org) { return !!org && !org.disabledAt && org.status !== "DISABLED" && org.status !== "SUSPENDED"; }

/** Re-checks who is allowed to run this, from live records. Returns { membership } or throws a fatal error. */
async function authorizeRun({ exec, definition, workflow, org }) {
  if (!orgIsActive(org)) throw Object.assign(new Error("The organization is disabled or no longer exists."), { code: "ORG_INACTIVE", fatal: true });
  if (exec.mode === "production" && (!workflow || workflow.deletedAt || workflow.status !== "ACTIVE")) throw Object.assign(new Error("The workflow is disabled or no longer active."), { code: "WORKFLOW_INACTIVE", fatal: true, cancel: true });
  const membership = await getMembership(exec.orgId, exec.runAs);
  if (!membership) throw Object.assign(new Error(`The run identity (${exec.runAs}) is no longer an active member of this organization.`), { code: "PERMISSION_REVOKED", fatal: true });
  const settings = normalizeSettings(definition.settings);
  for (const s of requiredScopes(definition)) {
    if (!settings.dataScopes.includes(s)) throw Object.assign(new Error(`The workflow does not declare the "${s}" scope.`), { code: "SCOPE_NOT_DECLARED", fatal: true });
    if (!scopeHeld(membership, s)) throw Object.assign(new Error(`The run identity does not hold the "${s}" data scope needed by this workflow.`), { code: "PERMISSION_DENIED", fatal: true });
  }
  return { membership, settings };
}

// ------------------------------------------------------------- graph logic
function buildGraph(definition) {
  const nodes = new Map(definition.nodes.filter((n) => !n.disabled).map((n) => [n.key, n]));
  const incoming = new Map(); const outgoing = new Map();
  for (const e of definition.edges) {
    if (!nodes.has(e.from) || !nodes.has(e.to)) continue;
    const edge = { from: e.from, to: e.to, port: e.fromPort || "out" };
    if (!incoming.has(e.to)) incoming.set(e.to, []); incoming.get(e.to).push(edge);
    if (!outgoing.has(e.from)) outgoing.set(e.from, []); outgoing.get(e.from).push(edge);
  }
  return { nodes, incoming, outgoing };
}

/** An edge is live when its source completed and (for a condition) chose that port. */
function edgeLive(edge, results, graph) {
  const r = results[edge.from];
  if (!r || r.status !== "COMPLETED") return false;
  if (graph.nodes.get(edge.from)?.type === "condition.if") return r.output?.branch === edge.port;
  return true;
}

/** ready | skip | wait | blocked for one not-yet-finished node. */
function nodeReadiness(key, results, graph) {
  const node = graph.nodes.get(key);
  if (NODE_TYPES[node.type].category === "trigger") return "ready";
  const ins = graph.incoming.get(key) || [];
  if (!ins.length) return "skip";
  let anyLive = false; let anyPending = false; let anyWaiting = false; let anyFailed = false;
  for (const e of ins) {
    const s = results[e.from]?.status;
    if (!s || s === "PENDING" || s === "RUNNING") anyPending = true;
    else if (s === "WAITING") anyWaiting = true;
    else if (s === "FAILED") anyFailed = true;
    else if (edgeLive(e, results, graph)) anyLive = true;
  }
  if (anyPending) return "wait";
  if (anyWaiting) return "blocked";
  if (anyLive) return "ready";
  return anyFailed ? "skip-failed" : "skip";
}

// ------------------------------------------------------------ node running
function scopeFor(exec, definition, results, extra = {}) {
  const nodes = {};
  for (const [k, r] of Object.entries(results)) if (r.status === "COMPLETED" || r.status === "WAITING") nodes[k] = { output: r.output, status: r.status };
  return { nodes, trigger: exec.trigger?.payload ? { ...exec.trigger, ...exec.trigger.payload } : exec.trigger || {}, workflow: { id: String(exec.workflowId), name: exec.workflowName, version: exec.workflowVersion }, now: new Date().toISOString(), mode: exec.mode, ...extra };
}

function pickInput(node, cfg, graph, results) {
  const ref = cfg.input;
  if (ref && results[ref]?.status === "COMPLETED") return results[ref].output;
  const preds = (graph.incoming.get(node.key) || []).filter((e) => results[e.from]?.status === "COMPLETED");
  return preds.length === 1 ? results[preds[0].from].output : Object.fromEntries(preds.map((e) => [e.from, results[e.from].output]));
}

function evalCondition(cfg, scope) {
  const rules = [];
  let ok = true;
  if (cfg.expression) ok = evaluateCondition(cfg.expression, scope);
  if (Array.isArray(cfg.rules) && cfg.rules.length) {
    const results = cfg.rules.map((r) => {
      const actual = evaluate(String(r.path), scope);
      const want = typeof r.value === "string" && /^[A-Za-z_]/.test(r.value) && r.valueIsPath ? evaluate(r.value, scope) : r.value;
      let pass;
      if (r.op === "exists") pass = actual !== undefined && actual !== null && actual !== "";
      else pass = Boolean(evaluate(`__a ${r.op} __b`, { __a: actual, __b: want }));
      rules.push({ path: r.path, op: r.op, value: want, actual, passed: pass });
      return pass;
    });
    const rulesOk = (cfg.combine || "AND") === "OR" ? results.some(Boolean) : results.every(Boolean);
    ok = cfg.expression ? ok && rulesOk : rulesOk;
  }
  if (cfg.negate) ok = !ok;
  return { result: ok, branch: ok ? "true" : "false", expression: cfg.expression || null, rules, evaluatedAt: new Date().toISOString() };
}

async function executeNode(node, env) {
  const { exec, definition, graph, results, dataCtx, settings, mode, testData, secrets, budget } = env;
  const cfgRaw = node.config || {};
  const type = node.type;
  const scope = scopeFor(exec, definition, results);
  const workflow = { id: String(exec.workflowId), version: exec.workflowVersion, name: exec.workflowName };
  const base = { orgId: exec.orgId, executionId: String(exec._id), nodeKey: node.key, actorEmail: exec.runAs, scope, settings, budget, secrets };

  // ------------------------------------------------------------------ triggers
  if (NODE_TYPES[type].category === "trigger") return { output: { triggeredAt: exec.startedAt, type: exec.trigger?.type, ...(exec.trigger?.payload ? { payload: exec.trigger.payload } : {}) }, meta: { actionClass: "read" } };

  // ---------------------------------------------------------------------- data
  if (type.startsWith("data.") || type === "http.request") {
    if (mode === "test") return { output: testData?.nodes?.[node.key] ?? {}, meta: { dataSource: "synthetic test dataset", synthetic: true, actionClass: "read" } };
    if (type === "data.support_tickets" || type === "http.request") {
      const method = (cfgRaw.method || "GET").toUpperCase();
      if (mode === "dry_run" && method !== "GET") return { output: { simulated: true, wouldCall: { method, url: renderTemplate(String(cfgRaw.url), scope) } }, meta: { actionClass: "medium", simulated: true } };
      const r = await runHttpRequest({ ...cfgRaw, method }, base);
      return { output: type === "data.support_tickets" ? normalizeTickets(r.output) : r.output, meta: { dataSource: `http:${r.meta.host}`, http: r.meta, actionClass: type === "http.request" ? "medium" : "read" } };
    }
    const out = await runDataNode(type, cfgRaw, dataCtx);
    return { output: out, meta: { dataSource: type.replace("data.", ""), actionClass: "read" } };
  }

  // ---------------------------------------------------------------- transforms
  if (type.startsWith("transform.")) {
    const input = pickInput(node, cfgRaw, graph, results);
    const named = (k) => results[k]?.output;
    let out;
    switch (type) {
      case "transform.merge": {
        const preds = (graph.incoming.get(node.key) || []).filter((e) => results[e.from]?.status === "COMPLETED");
        out = T.mergeInputs(Object.fromEntries(preds.map((e) => [e.from, results[e.from].output])), { mode: cfgRaw.mode });
        break;
      }
      case "transform.join": out = T.joinRows(named(cfgRaw.left), named(cfgRaw.right), cfgRaw); break;
      case "transform.filter": out = T.filterRows(input, cfgRaw.expression); break;
      case "transform.map": out = T.mapRows(input, cfgRaw.fields, { keep: cfgRaw.keep !== false }); break;
      case "transform.derive": out = T.deriveFields(input, cfgRaw.fields); break;
      case "transform.select": out = T.selectFields(input, cfgRaw.fields); break;
      case "transform.rename": out = T.renameFields(input, cfgRaw.mapping); break;
      case "transform.sort": out = T.sortRows(input, cfgRaw); break;
      case "transform.aggregate": out = T.aggregateRows(input, cfgRaw.metrics); break;
      case "transform.group": out = T.groupRows(input, cfgRaw); break;
      case "transform.dedupe": out = T.dedupeRows(input, cfgRaw); break;
      default: throw Object.assign(new Error(`Unsupported transform ${type}`), { retryable: false });
    }
    return { output: out, meta: { actionClass: "read" } };
  }

  // ----------------------------------------------------------------------- KPI
  if (type === "kpi.snapshot") {
    const preds = Object.fromEntries((graph.incoming.get(node.key) || []).filter((e) => results[e.from]?.status === "COMPLETED").flatMap((e) => flattenUpstream(e.from, results, graph)));
    if (mode === "test") return { output: testData?.nodes?.[node.key] ?? { snapshot: { synthetic: true, generatedAt: new Date().toISOString(), period: { days: cfgRaw.periodDays || 30 }, sourceSystems: Object.keys(preds), kpis: {}, ...syntheticKpis(preds) } }, meta: { dataSource: "synthetic test dataset", synthetic: true, actionClass: "read" } };
    return { output: await buildKpiSnapshot(cfgRaw, dataCtx, preds), meta: { dataSource: "business-insights", actionClass: "read" } };
  }

  // ------------------------------------------------------------------------ AI
  if (type === "ai.agent") {
    const preds = Object.fromEntries((graph.incoming.get(node.key) || []).filter((e) => results[e.from]?.status === "COMPLETED").map((e) => [e.from, results[e.from].output]));
    const nodeTypes = Object.fromEntries([...graph.nodes.entries()].map(([k, n]) => [k, n.type]));
    const outputs = Object.fromEntries(Object.entries(results).filter(([, r]) => r.status === "COMPLETED").map(([k, r]) => [k, r.output]));
    const r = await runAiAgent(cfgRaw, {
      orgId: exec.orgId, workflow, executionId: String(exec._id), nodeKey: node.key, dataCtx, inputs: preds, results: outputs, nodeTypes, settings, mode, budget, scope,
      declaredScopes: settings.dataScopes, aiStub: testData?.ai, testTools: testData?.tools,
      notifyCtx: { ...base, workflow, executionDate: exec.executionDate },
      recordEvidence: (kind, data) => env.rec({ orgId: exec.orgId, workflowId: exec.workflowId, executionId: exec._id, action: kind, nodeKey: node.key, mode, actorEmail: exec.runAs, actorType: "workflow", data }),
      logTool: (e) => env.rec({ orgId: exec.orgId, workflowId: exec.workflowId, executionId: exec._id, action: "AI_TOOL_CALLED", nodeKey: node.key, mode, actorEmail: exec.runAs, actorType: "ai", result: e.decision, data: e, graph: false }),
    });
    return { output: r.output, meta: { dataSource: "ai", actionClass: "low", model: r.output.model } };
  }

  // ----------------------------------------------------------------- condition
  if (type === "condition.if") {
    return { output: evalCondition(cfgRaw, scope), meta: { actionClass: "read" } };
  }

  // ------------------------------------------------------------- notifications
  if (type.startsWith("notify.")) {
    const r = await runNotifyNode(type, cfgRaw, { ...base, workflow, mode, executionDate: exec.executionDate });
    return { output: r.output, meta: { actionClass: "low", simulated: r.output.simulated === true } };
  }

  // ------------------------------------------------------------ approval / action
  if (type === "action.propose") {
    const args = {};
    for (const [k, v] of Object.entries(cfgRaw.args || {})) args[k] = typeof v === "string" ? renderTemplate(v, scope) : v;
    if (mode !== "production") return { output: { simulated: true, wouldPropose: { tool: cfgRaw.tool, args }, note: `In ${mode} mode no approval request was created.` }, meta: { actionClass: "high", simulated: true } };
    const key = effectKey("propose", exec._id, node.key);
    const claim = await claimEffect({ orgId: exec.orgId, key, kind: "action.propose", executionId: exec._id, nodeKey: node.key, meta: { tool: cfgRaw.tool } });
    if (!claim.claimed) {
      const prior = claim.effect?.result;
      if (prior?.requestId) return { output: { ...prior, reused: true }, meta: { actionClass: "high" }, waiting: cfgRaw.waitForApproval !== false && !RESOLVED_APPROVAL.has(prior.status) };
      throw Object.assign(new Error("A previous attempt started this approval request but did not record the result; refusing to create a duplicate."), { retryable: false, code: "EFFECT_UNCERTAIN" });
    }
    const since = new Date(Date.now() - 5000).toISOString();
    const r = await submitApprovalRequest({ tool: cfgRaw.tool, args, dataCtx, since });
    if (r.error) { await completeEffect({ orgId: exec.orgId, key, state: "FAILED", result: { error: r.error } }); throw Object.assign(new Error(r.error), { retryable: false, code: "PROPOSE_REFUSED" }); }
    await completeEffect({ orgId: exec.orgId, key, state: "DONE", result: { requestId: r.requestId, status: r.status, tool: cfgRaw.tool } });
    await env.rec({ orgId: exec.orgId, workflowId: exec.workflowId, executionId: exec._id, action: "APPROVAL_REQUESTED", nodeKey: node.key, mode, actorEmail: exec.runAs, actorType: "workflow", data: { tool: cfgRaw.tool, requestId: r.requestId, status: r.status, note: "Proposed only: a human must approve, then the standard controlled-action delay applies." } });
    return { output: { submitted: true, requestId: r.requestId, status: r.status, tool: cfgRaw.tool }, meta: { actionClass: "high" }, waiting: cfgRaw.waitForApproval !== false };
  }

  if (type === "action.report") {
    const outputs = Object.fromEntries(Object.entries(results).filter(([, r]) => r.status === "COMPLETED").map(([k, r]) => [k, { type: r.type, output: r.output }]));
    const { orgs } = await getOrgCollections();
    const org = await orgs.findOne({ _id: toObjectId(exec.orgId) });
    const report = buildReport({ reportType: cfgRaw.reportType || "daily_operations", title: cfgRaw.title ? renderTemplate(cfgRaw.title, scope) : null, orgName: org?.name, outputs, workflow, executionId: String(exec._id), mode });
    return { output: report, meta: { actionClass: "read" } };
  }

  // ---------------------------------------------------------------- simulation
  if (type === "simulation.twin") {
    if (mode === "test") return { output: testData?.nodes?.[node.key] ?? { simulated: true, synthetic: true }, meta: { synthetic: true, actionClass: "read" } };
    let entityId = cfgRaw.entityId ? renderTemplate(String(cfgRaw.entityId), scope) : null;
    if (!entityId && cfgRaw.entityName) {
      const want = renderTemplate(String(cfgRaw.entityName), scope).toLowerCase();
      const hit = dataCtx.bc.scope.visibleSuppliers.find((s) => String(s.name).toLowerCase() === want) || dataCtx.bc.scope.visibleSuppliers.find((s) => String(s.name).toLowerCase().includes(want));
      if (!hit) throw Object.assign(new Error(`No supplier named "${want}" is visible to the run identity.`), { retryable: false, code: "ENTITY_NOT_FOUND" });
      entityId = String(hit._id);
    }
    const sim = await simulateDigitalTwinScenario({ orgId: exec.orgId, scenarioType: cfgRaw.scenarioType, entityId, membership: dataCtx.membership, actorEmail: exec.runAs, params: { ...(cfgRaw.params || {}), source: "workflow" } });
    if (sim.error) throw Object.assign(new Error(sim.error), { retryable: false, code: "TWIN_ERROR" });
    await env.rec({ orgId: exec.orgId, workflowId: exec.workflowId, executionId: exec._id, action: "SIMULATION_LINKED", nodeKey: node.key, mode, actorEmail: exec.runAs, actorType: "workflow", data: { simulationId: sim.simulation.simulationId, scenarioType: cfgRaw.scenarioType, integrityHash: sim.simulation.integrityHash, resultStatus: sim.simulation.resultStatus, note: "Simulation only: no production record was modified." } });
    return { output: { simulation: sim.simulation }, meta: { actionClass: "read", dataSource: "digital-twin (read-only)" } };
  }

  // ------------------------------------------------------------------ evidence
  if (type === "evidence.record") {
    const note = renderTemplate(cfgRaw.note || "Workflow evidence note", scope).slice(0, 500);
    const r = await env.rec({ orgId: exec.orgId, workflowId: exec.workflowId, executionId: exec._id, action: "AI_EVIDENCE_NOTE", nodeKey: node.key, mode, actorEmail: exec.runAs, actorType: "workflow", data: { note } });
    return { output: { recorded: r.ok, evidenceId: r.evidenceId || null, note }, meta: { actionClass: "low" } };
  }

  throw Object.assign(new Error(`No executor for node type ${type}.`), { retryable: false });
}

function flattenUpstream(fromKey, results, graph) {
  const out = [[fromKey, results[fromKey].output]];
  // a transform between the data nodes and the KPI node: also expose the data nodes behind it
  const node = graph.nodes.get(fromKey);
  if (node?.type === "transform.merge") for (const e of graph.incoming.get(fromKey) || []) if (results[e.from]?.status === "COMPLETED") out.push([e.from, results[e.from].output]);
  return out;
}

function syntheticKpis(preds) {
  const out = {};
  for (const v of Object.values(preds)) {
    if (v && typeof v === "object") {
      if (v.totalOverdue !== undefined) out.overdueInvoices = { count: v.count, total: v.totalOverdue };
      if (v.overdueCount !== undefined) out.taskBacklog = { open: v.openCount, overdue: v.overdueCount };
      if (v.totals?.openPipelineValue !== undefined) out.salesPipeline = { openValue: v.totals.openPipelineValue };
      if (v.openTickets !== undefined || v.tickets) out.supportBacklog = { open: v.openCount ?? v.tickets?.length ?? 0, urgent: v.urgentCount ?? 0 };
    }
  }
  return out;
}

/** Support tickets from the helpdesk (any shape) -> { tickets, openCount, urgentCount }. */
export function normalizeTickets(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.tickets) ? raw.tickets : Array.isArray(raw?.rows) ? raw.rows : [];
  const tickets = list.slice(0, 200).map((t) => ({ id: t.id ?? t.ticketId ?? null, subject: String(t.subject ?? t.title ?? "").slice(0, 200), status: String(t.status ?? "open").toLowerCase(), priority: String(t.priority ?? "normal").toLowerCase(), createdAt: t.createdAt ?? t.created_at ?? null, slaBreached: t.slaBreached === true || t.sla_breached === true, source: "helpdesk" }));
  const open = tickets.filter((t) => !["closed", "solved", "resolved"].includes(t.status));
  return { tickets, openCount: open.length, urgentCount: open.filter((t) => ["urgent", "high", "critical"].includes(t.priority)).length, slaBreachedCount: open.filter((t) => t.slaBreached).length, source: "helpdesk (via HTTP connector)" };
}

// -------------------------------------------------------------- the runner
/**
 * Runs or resumes an execution that the caller has ALREADY claimed
 * (lease.owner === workerId). Returns the final execution record.
 */
export async function runExecution(executionId, { workerId }) {
  const { workflowExecutions, workflows, orgs } = await getOrgCollections();
  let exec = await workflowExecutions.findOne({ _id: toObjectId(executionId) });
  if (!exec) throw new Error("Execution not found.");
  if (exec.lease?.owner !== workerId) throw new LeaseLost();

  const persist = async (set, extra = {}) => {
    const r = await workflowExecutions.updateOne({ _id: exec._id, "lease.owner": workerId }, { $set: { ...set, "lease.expiresAt": new Date(Date.now() + LEASE_MS).toISOString(), "lease.heartbeatAt": new Date().toISOString() }, ...extra });
    if (!r.matchedCount) throw new LeaseLost();
  };
  const hb = setInterval(() => { workflowExecutions.updateOne({ _id: exec._id, "lease.owner": workerId }, { $set: { "lease.expiresAt": new Date(Date.now() + LEASE_MS).toISOString(), "lease.heartbeatAt": new Date().toISOString() } }).catch(() => {}); }, LEASE_MS / 3);
  hb.unref?.();

  const secrets = new Set();
  const startedAt = exec.startedAt || new Date().toISOString();
  // declared before anything can call finish(): the helper functions below close over these
  let results = { ...(exec.nodeResults || {}) };
  const budget = { ...(exec.budgets || {}) };
  let loaded = null;
  // Evidence is written through ONE serialized chain (the audit chain is sequential anyway), off the
  // critical path of the nodes; finish() drains it, and a resume reconciles anything a crash lost.
  let evq = Promise.resolve();
  const graphItems = [];
  const rec = (args) => {
    const p = evq.then(() => recordWorkflowEvidence({ graph: "defer", ...args })).then((r) => {
      if (r?.ok && r.graph?.deferred) graphItems.push({ evidenceId: r.evidenceId, type: r.graph.type, note: `${args.action}${args.nodeKey ? " @" + args.nodeKey : ""}` });
      return r;
    }).catch(() => ({ ok: false }));
    evq = p;
    return p;
  };
  try {
    const [org, workflow] = await Promise.all([orgs.findOne({ _id: exec.orgId }), workflows.findOne({ _id: exec.workflowId, orgId: exec.orgId })]);
    let auth;
    try {
      loaded = await loadDefinition(exec);
      auth = await authorizeRun({ exec, definition: loaded.definition, workflow, org });
    } catch (err) {
      if (err.fatal) return await finish(err.cancel ? "CANCELLED" : "FAILED", { code: err.code, message: err.message });
      throw err;
    }
    const { definition } = loaded;
    const { membership, settings } = auth;
    const graph = buildGraph(definition);
    const mode = exec.mode;
    for (const k of graph.nodes.keys()) if (!results[k]) results[k] = { status: "PENDING", type: graph.nodes.get(k).type };
    const dataCtx = mode === "test" ? { orgId: exec.orgId, membership, email: exec.runAs, bc: emptyBc() } : await buildDataContext({ orgId: exec.orgId, membership, email: exec.runAs });
    const testData = exec.testData || null;
    if (!exec.startedAt) {
      await persist({ status: "RUNNING", startedAt, definitionHash: loaded.definitionHash });
      await rec({ orgId: exec.orgId, workflowId: exec.workflowId, executionId: exec._id, action: "EXECUTION_STARTED", mode, actorEmail: exec.runAs, actorType: "workflow", data: { workflowVersion: exec.workflowVersion, trigger: exec.trigger?.type, scheduledFor: exec.trigger?.scheduledFor || null, initiatingIdentity: exec.initiatingIdentity, runAs: exec.runAs, definitionHash: loaded.definitionHash } });
    } else await persist({ status: "RUNNING" });

    const env = { exec: { ...exec, startedAt }, definition, graph, results, dataCtx, settings, mode, testData, secrets, budget, rec };
    if (exec.startedAt) await reconcileEvidence({ exec, results, env });
    const deadline = new Date(startedAt).getTime() + settings.maxDurationMs + (exec.pausedMs || 0);
    const failed = new Set(Object.entries(results).filter(([, r]) => r.status === "FAILED").map(([k]) => k));
    let stopAfterFailure = false;

    // ---- main scheduling loop
    for (;;) {
      const fresh = await workflowExecutions.findOne({ _id: exec._id }, { projection: { cancelRequested: 1, pauseRequested: 1, "lease.owner": 1 } });
      if (fresh?.lease?.owner !== workerId) throw new LeaseLost();
      if (fresh.cancelRequested) return await finish("CANCELLED", { code: "CANCELLED", message: "Cancelled by a user." });
      if (fresh.pauseRequested) { await persist({ status: "PAUSED", nodeResults: bounded(results, 3_000_000), budgets: budget }); return await releaseLease("PAUSED"); }
      if (Date.now() > deadline) return await finish("EXPIRED", { code: "MAX_DURATION", message: `The execution exceeded its maximum duration (${settings.maxDurationMs} ms).` });

      // live permission + workflow state re-check before each wave (revocation mid-run, disabled while running)
      const stillMember = await getMembership(exec.orgId, exec.runAs);
      if (!stillMember) return await finish("FAILED", { code: "PERMISSION_REVOKED", message: "The run identity lost access to the organization during the execution." });
      if (mode === "production") {
        const wf = await workflows.findOne({ _id: exec.workflowId, orgId: exec.orgId }, { projection: { status: 1, deletedAt: 1 } });
        if (!wf || wf.deletedAt || wf.status !== "ACTIVE") return await finish("CANCELLED", { code: "WORKFLOW_INACTIVE", message: "The workflow was disabled while this execution was running." });
      }

      const ready = []; let changed = false; let waiting = false;
      for (const key of graph.nodes.keys()) {
        const r = results[key];
        if (["COMPLETED", "FAILED", "SKIPPED"].includes(r.status)) continue;
        if (r.status === "WAITING") { waiting = true; continue; }
        const rd = nodeReadiness(key, results, graph);
        if (rd === "ready") ready.push(key);
        else if (rd === "skip" || rd === "skip-failed") { results[key] = { ...r, status: "SKIPPED", skippedReason: rd === "skip-failed" ? "An upstream node failed." : "Not on the branch that was taken.", completedAt: new Date().toISOString() }; changed = true; }
        else if (rd === "blocked") waiting = true;
      }
      if (changed) await persist({ nodeResults: bounded(results, 3_000_000) });
      if (!ready.length) {
        if (changed) continue; // skipping may have unblocked others
        break;
      }
      if (stopAfterFailure) break;

      // run a bounded wave in parallel
      const wave = ready.slice(0, MAX_PARALLEL);
      await Promise.all(wave.map(async (key) => {
        const out = await runOneNode(graph.nodes.get(key), env, persist, results);
        if (out === "FAILED") { failed.add(key); if (settings.onNodeFailure !== "continue") stopAfterFailure = true; }
        if (out === "RETRY_LATER") env.retryLater = true;
      }));
      await persist({ nodeResults: bounded(results, 3_000_000), budgets: budget });
      if (env.retryLater) {
        await persist({ status: "WAITING" });
        await workflowExecutions.updateOne({ _id: exec._id, "lease.owner": workerId }, { $set: { nextAttemptAt: new Date(Date.now() + (env.retryDelayMs || 10_000)).toISOString() } });
        return await releaseLease("WAITING");
      }
    }

    // ---- terminal decision
    const anyFailed = [...graph.nodes.keys()].some((k) => results[k].status === "FAILED");
    if (anyFailed) for (const k of graph.nodes.keys()) if (results[k].status === "PENDING") results[k] = { ...results[k], status: "SKIPPED", skippedReason: "The execution stopped after a failure.", completedAt: new Date().toISOString() };
    const anyWaiting = [...graph.nodes.keys()].some((k) => results[k].status === "WAITING");
    if (anyFailed) {
      const bad = [...graph.nodes.keys()].find((k) => results[k].status === "FAILED");
      return await finish("FAILED", { code: results[bad].error?.code || "NODE_FAILED", message: `Node "${bad}" failed: ${results[bad].error?.message}`, failedNode: bad, partial: [...graph.nodes.keys()].some((k) => results[k].status === "COMPLETED") });
    }
    if (anyWaiting) {
      await persist({ status: "WAITING_APPROVAL", nodeResults: bounded(results, 3_000_000), budgets: budget, summary: summarizeExecution(results, graph) });
      await rec({ orgId: exec.orgId, workflowId: exec.workflowId, executionId: exec._id, action: "EXECUTION_WAITING_APPROVAL", mode, actorEmail: exec.runAs, actorType: "workflow", data: { waitingNodes: [...graph.nodes.keys()].filter((k) => results[k].status === "WAITING") }, graph: false });
      return await releaseLease("WAITING_APPROVAL");
    }
    return await finish("COMPLETED", {});

    // ------------------------------------------------------------ helpers
    async function finish(status, info) {
      const completedAt = new Date().toISOString();
      const summary = loaded ? summarizeExecution(results, buildGraph(loaded.definition)) : exec.summary || {};
      const errors = status === "COMPLETED" ? [] : [{ code: info.code, message: redact(info.message, { secrets: [...secrets] }), at: completedAt, ...(info.failedNode ? { failedNode: info.failedNode } : {}) }];
      await persist({
        status, completedAt, durationMs: Date.parse(completedAt) - Date.parse(startedAt), errors, summary: { ...summary, ...(info.failedNode ? { failedNode: info.failedNode } : {}), partial: !!info.partial },
        nodeResults: bounded(results, 3_000_000), budgets: budget, "lease.owner": null,
      }).catch((e) => { if (!(e instanceof LeaseLost)) throw e; });
      await evq;
      const kind = status === "COMPLETED" ? "EXECUTION_COMPLETED" : status === "CANCELLED" ? "EXECUTION_CANCELLED" : status === "EXPIRED" ? "EXECUTION_EXPIRED" : "EXECUTION_FAILED";
      await rec({ orgId: exec.orgId, workflowId: exec.workflowId, executionId: exec._id, action: kind, mode: exec.mode, result: status, actorEmail: exec.runAs, actorType: "workflow", data: { status, ...info, message: info.message ? redact(info.message, { secrets: [...secrets] }) : undefined, summary } });
      await evq;
      if (exec.mode === "production" && graphItems.length) await linkExecutionGraphBatch({ orgId: exec.orgId, executionId: exec._id, items: graphItems.splice(0) });
      if (status === "FAILED" && exec.mode === "production" && loaded) await notifyFailure({ exec, definition: loaded.definition, info, results }).catch(() => {});
      return await workflowExecutions.findOne({ _id: exec._id });
    }
    async function releaseLease(status) {
      await evq;
      if (exec.mode === "production" && graphItems.length) await linkExecutionGraphBatch({ orgId: exec.orgId, executionId: exec._id, items: graphItems.splice(0) });
      await workflowExecutions.updateOne({ _id: exec._id, "lease.owner": workerId }, { $set: { "lease.owner": null, status } });
      return await workflowExecutions.findOne({ _id: exec._id });
    }
  } finally {
    clearInterval(hb);
  }
}

function emptyBc() {
  return { scope: { visibleDeals: [], visibleContacts: [], visibleInvoices: [], visibleTasks: [], visiblePurchaseOrders: [], visiblePurchaseRequests: [], visibleSuppliers: [], visibleProducts: [], visibleWarehouses: [], visibleProjects: [], visibleDocuments: [] }, deptNameById: new Map(), projNameById: new Map(), contactNameById: new Map(), supplierNameById: new Map() };
}

function summarizeExecution(results, graph) {
  const s = { notificationsSent: 0, actionsProposed: 0, nodesExecuted: 0, retryCount: 0 };
  for (const [k, r] of Object.entries(results)) {
    if (r.status === "COMPLETED") s.nodesExecuted++;
    s.retryCount += r.retryCount || 0;
    if (r.status === "FAILED" && !s.failedNode) s.failedNode = k;
    if (r.type === "condition.if" && r.status === "COMPLETED") { s.branch = r.output?.branch === "true" ? "yes" : "no"; s.decisionNode = k; }
    if (r.type === "ai.agent" && r.status === "COMPLETED" && r.output?.result) s.aiDecision = { urgent: r.output.result.urgent, classification: r.output.result.classification, confidence: r.output.result.confidence };
    if (r.type?.startsWith("notify.") && r.status === "COMPLETED") s.notificationsSent += r.output?.simulated ? 0 : (r.output?.delivered || 0);
    if (r.type === "action.propose" && ["COMPLETED", "WAITING"].includes(r.status) && !r.output?.simulated) s.actionsProposed++;
    if (r.type === "action.propose" && r.output?.requestId) s.approvalState = r.output.approvalStatus || r.output.status;
    if (r.type === "action.report" && r.status === "COMPLETED") s.reportGenerated = true;
  }
  return s;
}

async function notifyFailure({ exec, definition, info, results }) {
  const settings = normalizeSettings(definition.settings);
  if (!settings.failureNotification.enabled) return;
  const failedNode = info.failedNode || "unknown";
  const attempts = results?.[failedNode]?.attempts || 0;
  await runNotifyNode("notify.inaya", { title: `Workflow failed: ${exec.workflowName}`, body: `Workflow: ${exec.workflowName}\nStatus: FAILED\nNode: ${failedNode}\nReason: ${String(info.message || "").slice(0, 300)}\nRetry attempts: ${attempts}\nExecution: ${exec._id}`, severity: "critical", audience: settings.failureNotification.recipients?.length ? undefined : "managers", recipients: settings.failureNotification.recipients, alertType: "failure", entityId: String(exec._id) },
    { orgId: exec.orgId, workflow: { id: String(exec.workflowId), version: exec.workflowVersion, name: exec.workflowName }, executionId: String(exec._id), nodeKey: "failure", scope: {}, settings, mode: "production", secrets: new Set(), actorEmail: "system", executionDate: exec.executionDate });
}

/** Runs one node with retry/backoff, timeout, evidence, and result persistence. Returns COMPLETED | FAILED | WAITING | RETRY_LATER. */
async function runOneNode(node, env, persist, results) {
  const { exec, settings, mode, secrets } = env;
  const def = NODE_TYPES[node.type];
  const prev = results[node.key] || {};
  const startedAt = new Date().toISOString();
  const maxAttempts = Math.max(1, Math.min(settings.retry.maxAttempts, 5));
  const attemptLog = [...(prev.attemptLog || [])];
  let attempts = prev.attempts || 0;
  const t0 = Date.now();
  results[node.key] = { ...prev, type: node.type, name: node.name || node.key, status: "RUNNING", startedAt, attempts };

  // re-check identity between nodes (SOW §60: permission revoked during execution)
  const m = await getMembership(exec.orgId, exec.runAs);
  if (!m) { results[node.key] = { ...results[node.key], status: "FAILED", completedAt: new Date().toISOString(), error: { code: "PERMISSION_REVOKED", message: "The run identity lost access before this node ran." }, attemptLog }; return "FAILED"; }
  if (def.scope && !scopeHeld(m, def.scope)) { results[node.key] = { ...results[node.key], status: "FAILED", completedAt: new Date().toISOString(), error: { code: "PERMISSION_DENIED", message: `The run identity does not hold the "${def.scope}" scope.` }, attemptLog }; return "FAILED"; }

  for (;;) {
    attempts++;
    try {
      const fault = mode === "test" ? env.testData?.faults?.[node.key] : null;
      if (fault && attempts <= (fault.times ?? 1)) throw Object.assign(new Error(fault.type === "timeout" ? "Injected timeout" : "Injected failure"), { retryable: fault.retryable !== false, code: fault.type === "timeout" ? "TIMEOUT" : "INJECTED_FAULT" });
      const timeout = node.type === "ai.agent" ? settings.aiTimeoutMs : settings.timeoutMs;
      const r = await withTimeout(executeNode(node, env), timeout, `Node "${node.key}"`);
      const output = bounded(redact(r.output, { secrets: [...secrets] }), 250_000);
      const completedAt = new Date().toISOString();
      const inputSummary = summarizeInputs(node, env, results);
      results[node.key] = {
        type: node.type, name: node.name || node.key, status: r.waiting ? "WAITING" : "COMPLETED", startedAt, completedAt, durationMs: Date.now() - t0, attempts, retryCount: attempts - 1, attemptLog,
        inputSummary, output, outputSummary: summarize(output), actionClass: r.meta?.actionClass || def.risk, dataSource: r.meta?.dataSource || null, simulated: !!r.meta?.simulated, synthetic: !!r.meta?.synthetic,
        permissionContext: { executingIdentity: exec.runAs, role: m.role, scope: def.scope || null, mode }, ...(r.meta?.http ? { http: r.meta.http } : {}),
      };
      recordNodeEvidence(node, results[node.key], env, output); // queued; drained by finish()
      return r.waiting ? "WAITING" : "COMPLETED";
    } catch (err) {
      if (err instanceof LeaseLost) throw err;
      const retryable = err.retryable !== false && err.code !== "PERMISSION_DENIED" && !err.fatal;
      attemptLog.push({ attempt: attempts, error: { code: err.code || "ERROR", message: redact(String(err.message), { secrets: [...secrets] }).slice(0, 400) }, at: new Date().toISOString(), retryable });
      if (retryable && attempts < maxAttempts) {
        const delay = backoffMs(attempts, settings.retry.baseDelayMs);
        if (delay <= IN_PROCESS_BACKOFF_MS) { await sleep(delay); continue; }
        results[node.key] = { ...results[node.key], status: "PENDING", attempts, retryCount: attempts - 1, attemptLog, retryAt: new Date(Date.now() + delay).toISOString() };
        env.retryDelayMs = delay; return "RETRY_LATER";
      }
      results[node.key] = { type: node.type, name: node.name || node.key, status: "FAILED", startedAt, completedAt: new Date().toISOString(), durationMs: Date.now() - t0, attempts, retryCount: attempts - 1, attemptLog, error: { code: err.code || "ERROR", message: redact(String(err.message), { secrets: [...secrets] }).slice(0, 400), retriesExhausted: retryable }, inputSummary: summarizeInputs(node, env, results), actionClass: def.risk, permissionContext: { executingIdentity: exec.runAs, role: m.role, scope: def.scope || null, mode } };
      env.rec({ orgId: exec.orgId, workflowId: exec.workflowId, executionId: exec._id, action: "NODE_FAILED", nodeKey: node.key, mode, result: "FAILED", actorEmail: exec.runAs, actorType: "workflow", data: { type: node.type, attempts, error: results[node.key].error, attemptLog }, graph: false, secrets: [...secrets] });
      return "FAILED";
    }
  }
}

function summarizeInputs(node, env, results) {
  const preds = (env.graph.incoming.get(node.key) || []).filter((e) => results[e.from]?.status === "COMPLETED");
  return Object.fromEntries(preds.map((e) => [e.from, summarize(results[e.from].output)]));
}

async function recordNodeEvidence(node, r, env, output) {
  const { exec, mode, secrets } = env;
  const t = node.type;
  if (NODE_TYPES[t].category === "trigger") return; // the trigger is recorded by EXECUTION_STARTED
  const base = { orgId: exec.orgId, workflowId: exec.workflowId, executionId: exec._id, nodeKey: node.key, mode, actorEmail: exec.runAs, actorType: "workflow", secrets: [...secrets] };
  const common = { type: t, status: r.status, durationMs: r.durationMs, attempts: r.attempts, actionClass: r.actionClass, dataSource: r.dataSource, outputSummary: r.outputSummary, outputHash: canonicalHash(output ?? null) };
  // one row per node: the specific kind when there is one (it also becomes an Evidence Graph relationship), NODE_EXECUTED otherwise
  if (t.startsWith("data.") || t === "http.request") return env.rec({ ...base, action: "DATA_READ", data: { ...common, permissionContext: r.permissionContext } });
  if (t === "kpi.snapshot") return env.rec({ ...base, action: "KPI_SNAPSHOT", data: { ...common, snapshotHash: canonicalHash(output ?? null), sourceSystems: output?.snapshot?.sourceSystems, period: output?.snapshot?.period } });
  if (t === "ai.agent") return env.rec({ ...base, action: "AI_ANALYSIS", data: { ...common, model: output?.model, result: output?.result, deterministic: output?.deterministic, explainability: output?.explainability } });
  if (t === "condition.if") return env.rec({ ...base, action: "DECISION_MADE", data: { ...common, expression: output?.expression, rules: output?.rules, result: output?.result, branch: output?.branch } });
  if (t.startsWith("notify.") && !output?.simulated) return env.rec({ ...base, action: "NOTIFICATION_SENT", data: { ...common, channel: output?.channel, delivered: output?.delivered, deliveries: output?.deliveries, dedupeKey: output?.dedupeKey } });
  if (t === "action.report") return env.rec({ ...base, action: "REPORT_GENERATED", data: { ...common, reportType: output?.report?.reportType, reportHash: canonicalHash(output ?? null) } });
  if (t === "action.propose" || t === "simulation.twin") return; // already recorded with richer data (APPROVAL_REQUESTED / SIMULATION_LINKED)
  return env.rec({ ...base, action: "NODE_EXECUTED", graph: false, data: common });
}

/** After a crash the node results are durable but the queued evidence may not be: re-record what is missing. */
async function reconcileEvidence({ exec, results, env }) {
  try {
    const have = new Set((await listWorkflowEvidence({ orgId: exec.orgId, executionId: exec._id })).map((r) => r.nodeKey).filter(Boolean));
    for (const [k, r] of Object.entries(results)) {
      if (r.status === "COMPLETED" && !have.has(k) && env.graph.nodes.has(k) && NODE_TYPES[r.type]?.category !== "trigger" && !["action.propose", "simulation.twin"].includes(r.type)) {
        await recordNodeEvidence({ key: k, type: r.type }, r, env, r.output);
      }
    }
  } catch { /* reconciliation is best effort; the node results themselves are the source of truth */ }
}

// ---------------------------------------------------------- approval resume
/** Resolves WAITING approval nodes of one execution against their controlled-action requests. Returns true if any changed. */
export async function resolveApprovalWaits(executionId) {
  const { workflowExecutions, aiActionRequests } = await getOrgCollections();
  const exec = await workflowExecutions.findOne({ _id: toObjectId(executionId) });
  if (!exec || exec.status !== "WAITING_APPROVAL") return { changed: false };
  const results = { ...(exec.nodeResults || {}) };
  let changed = false; let stillWaiting = false;
  for (const [k, r] of Object.entries(results)) {
    if (r.status !== "WAITING") continue;
    if (!r.output?.requestId) { stillWaiting = true; continue; }
    const req = await aiActionRequests.findOne({ _id: toObjectId(r.output.requestId), orgId: exec.orgId });
    if (!req) { results[k] = { ...r, status: "FAILED", error: { code: "APPROVAL_MISSING", message: "The approval request no longer exists." } }; changed = true; continue; }
    if (RESOLVED_APPROVAL.has(req.status)) {
      results[k] = { ...r, status: "COMPLETED", completedAt: new Date().toISOString(), output: { ...r.output, approvalStatus: req.status, reviewedBy: req.reviewedByEmail || null, reviewedAt: req.reviewedAt || null, executedAt: req.executedAt || null } };
      changed = true;
      await recordWorkflowEvidence({ orgId: exec.orgId, workflowId: exec.workflowId, executionId: exec._id, action: "APPROVAL_RESOLVED", nodeKey: k, mode: exec.mode, result: req.status, actorEmail: req.reviewedByEmail || "system", actorType: req.reviewedByEmail ? "human" : "system", data: { requestId: String(req._id), status: req.status, reviewedBy: req.reviewedByEmail || null, reviewedAt: req.reviewedAt || null } });
      if (req.status === "EXECUTED") await recordWorkflowEvidence({ orgId: exec.orgId, workflowId: exec.workflowId, executionId: exec._id, action: "ACTION_EXECUTED", nodeKey: k, mode: exec.mode, actorEmail: "system", actorType: "system", data: { requestId: String(req._id), tool: req.toolName, targetRecordType: req.targetRecordType, executedAt: req.executedAt || null, via: "existing controlled-action executor" } });
    } else stillWaiting = true;
  }
  if (changed) {
    await workflowExecutions.updateOne({ _id: exec._id, status: "WAITING_APPROVAL" }, { $set: { nodeResults: bounded(results, 3_000_000), ...(stillWaiting ? {} : { status: "QUEUED", nextAttemptAt: new Date().toISOString() }) } });
  }
  return { changed, resumed: changed && !stillWaiting };
}

export { LeaseLost, buildGraph, nodeReadiness, evalCondition, summarizeExecution };
