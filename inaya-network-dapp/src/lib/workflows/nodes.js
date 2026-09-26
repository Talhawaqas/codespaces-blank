// src/lib/workflows/nodes.js
//
// SOW §8-§19, §34: the typed node model. One registry describes every node type
// (category, ports, action risk class, the data scope it needs, and its config
// validator). The engine, the editor and the validator all read this one table,
// so they cannot drift apart.
//
// There is deliberately NO "code" node and NO payment / deletion / permission-
// change node: workflows connect existing Inaya capabilities, and anything
// consequential goes through action.propose -> the existing guarded-action
// approval system (ai-action-requests.js), never around it.

import { canAccessFinance, canManageOrg } from "../orgGates.js";
import { validateExpression, EXPRESSION_FUNCTIONS } from "./expr.js";
import { validateSchedule } from "./schedule.js";

export const NODE_KEY_RE = /^[a-z][A-Za-z0-9_]{0,39}$/;
export const RISK_CLASSES = ["read", "low", "medium", "high"];
export const CATEGORIES = ["trigger", "data", "transformation", "ai", "condition", "action", "notification", "simulation", "evidence"];

/** Data scopes a workflow must declare (settings.dataScopes) for the nodes it uses,
 *  and that the EXECUTING identity must hold. HR is intentionally not offered. */
export const DATA_SCOPES = ["crm", "tasks", "finance", "procurement", "inventory", "projects", "documents", "security", "backup", "trust", "insights", "evidence", "twin", "ai", "notify", "external_http", "propose"];

/** Does this membership hold the scope? (Live membership; never the definition's claim.) */
export function scopeHeld(membership, scope) {
  if (!membership) return false;
  switch (scope) {
    case "finance": return canAccessFinance(membership);
    case "security": case "backup": case "external_http": return canManageOrg(membership);
    case "propose": return true; // per-action permission is enforced by the propose tool itself
    default: return DATA_SCOPES.includes(scope);
  }
}

export const AI_MODELS = ["gemini-3.5-flash-lite"];
export const APPROVED_PROPOSE_TOOLS = ["propose_task_status_change", "propose_invoice_decision", "propose_purchase_order_transition", "propose_purchase_request_transition", "propose_deal_transition", "propose_leave_decision", "propose_expense_decision"];

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

function needExpr(cfg, field, errors, { optional = false } = {}) {
  if (cfg[field] === undefined || cfg[field] === "") { if (!optional) errors.push(`${field} is required.`); return; }
  const v = validateExpression(String(cfg[field]));
  if (!v.ok) errors.push(`${field}: ${v.error}`);
}
function needFields(cfg, errors, name) { if (!isObj(cfg[name]) || !Object.keys(cfg[name]).length) errors.push(`${name} must list at least one field.`); else for (const [k, e] of Object.entries(cfg[name])) { const v = validateExpression(String(e)); if (!v.ok) errors.push(`${name}.${k}: ${v.error}`); } }
const limitNum = (cfg, f, lo, hi, errors) => { if (cfg[f] !== undefined && !(Number.isFinite(cfg[f]) && cfg[f] >= lo && cfg[f] <= hi)) errors.push(`${f} must be between ${lo} and ${hi}.`); };

const dataNode = (label, scope, extra = {}) => ({ category: "data", label, ports: ["out"], risk: "read", scope, validate: (c, e) => limitNum(c, "limit", 1, 500, e), ...extra });

export const NODE_TYPES = {
  // ------------------------------------------------------------------ triggers
  "trigger.manual": { category: "trigger", label: "Manual trigger", ports: ["out"], risk: "read", validate: () => {} },
  "trigger.schedule": { category: "trigger", label: "Schedule trigger", ports: ["out"], risk: "read", validate: (c, e) => e.push(...validateSchedule(c.schedule)) },
  "trigger.event": { category: "trigger", label: "Event trigger", ports: ["out"], risk: "read", validate: (c, e) => { if (!/^[a-z0-9_.:-]{3,60}$/i.test(c.eventType || "")) e.push("eventType is required (for example invoice.overdue)."); } },
  "trigger.webhook": { category: "trigger", label: "Webhook trigger", ports: ["out"], risk: "read", validate: () => {} },
  "trigger.api": { category: "trigger", label: "API trigger", ports: ["out"], risk: "read", validate: () => {} },
  "trigger.evidence_event": { category: "trigger", label: "Evidence Graph event trigger", ports: ["out"], risk: "read", scope: "evidence", validate: (c, e) => { if (c.subjectType && !/^[A-Z_]{3,40}$/.test(c.subjectType)) e.push("subjectType must be an Evidence Graph subject type such as INVOICE."); } },
  "trigger.twin_complete": { category: "trigger", label: "Digital Twin simulation completed", ports: ["out"], risk: "read", scope: "twin", validate: () => {} },
  "trigger.data_change": { category: "trigger", label: "Data change trigger", ports: ["out"], risk: "read", validate: (c, e) => { if (!["overdue_invoices", "employee_tasks", "crm_sales", "support_tickets"].includes(c.source)) e.push("source must be one of overdue_invoices, employee_tasks, crm_sales, support_tickets."); limitNum(c, "checkEveryMinutes", 5, 1440, e); } },

  // -------------------------------------------------------------------- data
  "data.crm_sales": dataNode("Get CRM / Sales Data", "crm"),
  "data.overdue_invoices": dataNode("Get Overdue Invoices", "finance", { validate: (c, e) => { limitNum(c, "limit", 1, 500, e); limitNum(c, "minAmount", 0, 1e12, e); } }),
  "data.employee_tasks": dataNode("Get Employee Tasks", "tasks", { validate: (c, e) => { limitNum(c, "limit", 1, 500, e); if (c.onlyOverdue !== undefined && typeof c.onlyOverdue !== "boolean") e.push("onlyOverdue must be true or false."); } }),
  "data.procurement": dataNode("Get Procurement Data", "procurement"),
  "data.inventory": dataNode("Get Inventory Data", "inventory"),
  "data.projects": dataNode("Get Project Data", "projects"),
  "data.documents": dataNode("Get Document Workflow Data", "documents"),
  "data.security_events": dataNode("Get Security Events", "security"),
  "data.backup_status": dataNode("Get Backup / Integrity Status", "backup"),
  "data.trust_health": dataNode("Get Trust Health", "trust"),
  "data.business_brief": dataNode("Get Business Brief", "insights", { validate: (c, e) => { if (c.period && !["daily", "weekly", "monthly", "yearly"].includes(c.period)) e.push("period must be daily, weekly, monthly or yearly."); } }),
  "data.evidence_events": dataNode("Get Evidence Graph events", "evidence"),
  "data.twin_result": dataNode("Get Digital Twin simulation result", "twin"),
  "data.support_tickets": {
    category: "data", label: "Get Support Tickets (helpdesk via HTTP)", ports: ["out"], risk: "read", scope: "external_http",
    // Inaya has no ticketing system of its own; this reads the organization's helpdesk through the controlled connector.
    validate: (c, e) => { if (!c.url) e.push("url is required (the organization's helpdesk API)."); if (c.method && c.method !== "GET") e.push("Support ticket reads must use GET."); if (c.rowsPath !== undefined && typeof c.rowsPath !== "string") e.push("rowsPath must be text."); },
  },
  "http.request": {
    category: "data", label: "HTTP / API request", ports: ["out"], risk: "medium", scope: "external_http",
    validate: (c, e) => {
      if (!c.url) e.push("url is required.");
      if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(c.method || "GET")) e.push("method must be GET, POST, PUT, PATCH or DELETE.");
      if ((c.method || "GET") === "DELETE" && c.allowDelete !== true) e.push("DELETE is disabled unless the node sets allowDelete and the organization policy permits it.");
      if (!Array.isArray(c.allowedHosts) || !c.allowedHosts.length) e.push("allowedHosts must list the hosts this node may call.");
      limitNum(c, "timeoutMs", 500, 30000, e); limitNum(c, "maxResponseBytes", 1024, 2 * 1024 * 1024, e);
    },
  },

  // ---------------------------------------------------------- transformations
  "transform.merge": { category: "transformation", label: "Merge Business Data", ports: ["out"], risk: "read", validate: (c, e) => { if (c.mode && !["object", "concat"].includes(c.mode)) e.push("mode must be object or concat."); } },
  "transform.join": { category: "transformation", label: "Join", ports: ["out"], risk: "read", validate: (c, e) => { for (const f of ["left", "right", "leftKey", "rightKey"]) if (!c[f]) e.push(`${f} is required.`); } },
  "transform.filter": { category: "transformation", label: "Filter", ports: ["out"], risk: "read", validate: (c, e) => { needExpr(c, "expression", e); } },
  "transform.map": { category: "transformation", label: "Map fields", ports: ["out"], risk: "read", validate: (c, e) => needFields(c, e, "fields") },
  "transform.select": { category: "transformation", label: "Select fields", ports: ["out"], risk: "read", validate: (c, e) => { if (!Array.isArray(c.fields) || !c.fields.length) e.push("fields must list at least one field."); } },
  "transform.rename": { category: "transformation", label: "Rename fields", ports: ["out"], risk: "read", validate: (c, e) => { if (!isObj(c.mapping) || !Object.keys(c.mapping).length) e.push("mapping must list at least one rename."); } },
  "transform.sort": { category: "transformation", label: "Sort", ports: ["out"], risk: "read", validate: (c, e) => { if (!c.by) e.push("by is required."); } },
  "transform.aggregate": { category: "transformation", label: "Aggregate", ports: ["out"], risk: "read", validate: (c, e) => { if (!Array.isArray(c.metrics) || !c.metrics.length) e.push("metrics must list at least one metric."); } },
  "transform.group": { category: "transformation", label: "Group", ports: ["out"], risk: "read", validate: (c, e) => { if (!c.by) e.push("by is required."); } },
  "transform.dedupe": { category: "transformation", label: "Deduplicate", ports: ["out"], risk: "read", validate: () => {} },
  "transform.derive": { category: "transformation", label: "Calculate derived values", ports: ["out"], risk: "read", validate: (c, e) => needFields(c, e, "fields") },
  "kpi.snapshot": {
    category: "transformation", label: "Build KPI Snapshot", ports: ["out"], risk: "read", scope: "insights",
    validate: (c, e) => { if (c.periodDays !== undefined) limitNum(c, "periodDays", 1, 366, e); },
  },

  // ---------------------------------------------------------------------- AI
  "ai.agent": {
    category: "ai", label: "AI Operations Manager Agent", ports: ["out"], risk: "low", scope: "ai",
    validate: (c, e) => {
      if (c.model && !AI_MODELS.includes(c.model)) e.push(`model must be one of ${AI_MODELS.join(", ")}.`);
      limitNum(c, "temperature", 0, 1, e); limitNum(c, "maxOutputTokens", 64, 4096, e); limitNum(c, "maxToolCalls", 0, 10, e);
      if (c.systemInstructions !== undefined && String(c.systemInstructions).length > 4000) e.push("systemInstructions is longer than 4000 characters.");
      if (c.tools !== undefined && !(Array.isArray(c.tools) && c.tools.every((t) => typeof t === "string"))) e.push("tools must be a list of tool names.");
      if (c.thresholds !== undefined) {
        if (!Array.isArray(c.thresholds) || c.thresholds.length > 20) e.push("thresholds must be a list of up to 20 { name, expression, op, value }.");
        else for (const t of c.thresholds) {
          const v = validateExpression(String(t?.expression ?? ""));
          if (!v.ok) e.push(`threshold "${t?.name}": ${v.error}`);
          if (!["<", "<=", ">", ">=", "=="].includes(t?.op || ">")) e.push(`threshold "${t?.name}": op must be <, <=, >, >= or ==.`);
          if (!Number.isFinite(Number(t?.value))) e.push(`threshold "${t?.name}": value must be a number.`);
        }
      }
      if (c.inputFrom !== undefined && !(Array.isArray(c.inputFrom) && c.inputFrom.every((k) => typeof k === "string"))) e.push("inputFrom must be a list of node keys.");
      if (c.memory !== undefined && !isObj(c.memory)) e.push("memory must be an object.");
    },
  },

  // --------------------------------------------------------------- condition
  "condition.if": {
    category: "condition", label: "Urgent Problem Found? (condition)", ports: ["true", "false"], risk: "read",
    validate: (c, e) => {
      const hasRules = Array.isArray(c.rules) && c.rules.length;
      if (!c.expression && !hasRules) { e.push("A condition needs an expression or rules."); return; }
      if (c.expression) needExpr(c, "expression", e);
      if (hasRules) for (const r of c.rules) { if (!r?.path || !["==", "!=", ">", ">=", "<", "<=", "contains", "exists"].includes(r.op)) e.push("Each rule needs a path and an operator (==, !=, >, >=, <, <=, contains, exists)."); }
      if (c.combine && !["AND", "OR"].includes(c.combine)) e.push("combine must be AND or OR.");
    },
  },

  // ------------------------------------------------------------ notifications
  "notify.inaya": { category: "notification", label: "Inaya notification", ports: ["out"], risk: "low", scope: "notify", validate: notifyValidate },
  "notify.email": { category: "notification", label: "Email (Inaya delivery)", ports: ["out"], risk: "low", scope: "notify", validate: (c, e) => { notifyValidate(c, e); emailRecipients(c, e); } },
  "notify.slack": { category: "notification", label: "Slack message (unverified against live Slack)", ports: ["out"], risk: "low", scope: "notify", validate: (c, e) => { notifyValidate(c, e); if (!c.credentialId && !c.integration) e.push("Slack needs a credentialId (incoming webhook) or integration: \"slack\"."); } },
  "notify.gmail": { category: "notification", label: "Gmail message (unverified against live Gmail)", ports: ["out"], risk: "low", scope: "notify", validate: (c, e) => { notifyValidate(c, e); emailRecipients(c, e); if (!c.credentialId) e.push("Gmail needs a credentialId holding a Gmail OAuth token."); } },

  // ------------------------------------------------------------------ actions
  "action.propose": {
    category: "action", label: "Propose action for human approval", ports: ["out"], risk: "high", scope: "propose",
    validate: (c, e) => {
      if (!APPROVED_PROPOSE_TOOLS.includes(c.tool)) e.push(`tool must be one of ${APPROVED_PROPOSE_TOOLS.join(", ")}. Workflows cannot execute anything directly.`);
      if (!isObj(c.args) || !Object.keys(c.args).length) e.push("args must map the tool's arguments (values may use {{ }} templates).");
      if (c.requiresApproval === false) e.push("Approval cannot be disabled: every consequential action goes through the existing controlled-action approval.");
    },
  },
  "action.report": {
    category: "action", label: "Generate report", ports: ["out"], risk: "read",
    validate: (c, e) => { if (c.reportType && !REPORT_TYPES.includes(c.reportType)) e.push(`reportType must be one of ${REPORT_TYPES.join(", ")}.`); },
  },

  // --------------------------------------------------------------- simulation
  "simulation.twin": {
    category: "simulation", label: "Digital Twin simulation (read-only)", ports: ["out"], risk: "read", scope: "twin",
    validate: (c, e) => { if (!c.scenarioType) e.push("scenarioType is required."); if (!c.entityId && !c.entityName) e.push("entityId (or entityName) is required."); },
  },

  // ----------------------------------------------------------------- evidence
  "evidence.record": { category: "evidence", label: "Record evidence", ports: ["out"], risk: "low", scope: "evidence", validate: () => {} },
};

export const REPORT_TYPES = ["daily_operations", "weekly_operations", "urgent_alert", "executive_summary", "finance_exception", "support", "inventory", "trust_security", "simulation_impact"];

function notifyValidate(c, e) {
  if (!c.title && !c.subject) e.push("title (subject) is required.");
  if (!c.body) e.push("body is required.");
  if (c.severity && !["info", "warning", "critical"].includes(c.severity)) e.push("severity must be info, warning or critical.");
  if (c.alertType !== undefined && !/^[a-z0-9_.-]{1,40}$/i.test(c.alertType)) e.push("alertType may contain letters, numbers, . _ - only.");
  for (const f of ["title", "subject", "body"]) if (c[f]) for (const m of String(c[f]).matchAll(/\{\{([^{}]+)\}\}/g)) { const v = validateExpression(m[1].trim()); if (!v.ok) e.push(`${f} template: ${v.error}`); }
}
function emailRecipients(c, e) {
  const list = c.recipients;
  if (c.audience && ["managers", "all"].includes(c.audience) && (!Array.isArray(list) || !list.length)) return;
  if (!Array.isArray(list) || !list.length) { e.push("recipients must list at least one email address (or set audience to managers or all)."); return; }
  if (list.length > 20) e.push("At most 20 recipients per node.");
  for (const r of list) if (typeof r !== "string" || !EMAIL_RE.test(r)) e.push(`"${r}" is not a valid email address.`);
}

export const ACTION_RISK_POLICY = {
  read: "runs automatically",
  low: "runs automatically when the workflow declares the scope",
  medium: "runs automatically only when the workflow declares external_http and the publisher is an org manager",
  high: "never executes directly: creates a PENDING_APPROVAL controlled-action request",
};

export function listNodeTypes() {
  return Object.entries(NODE_TYPES).map(([type, d]) => ({ type, category: d.category, label: d.label, ports: d.ports, risk: d.risk, scope: d.scope || null }));
}

export const DEFAULT_SETTINGS = {
  dataScopes: [],
  timeoutMs: 30000, aiTimeoutMs: 60000, maxDurationMs: 10 * 60 * 1000,
  retry: { maxAttempts: 3, baseDelayMs: 1000 },
  onNodeFailure: "stop", // "stop" | "continue"
  failureNotification: { enabled: false, recipients: [] },
  limits: { perHour: 60, perDay: 500, concurrent: 3, maxAiOutputChars: 20000, maxHttpCalls: 20, maxToolCalls: 10 },
  retention: { executionDays: 90, aiOutputDays: 30, memoryDays: 30, reportDays: 180 },
  allowExternalRecipients: false,
  allowHttpDelete: false,
};

export function normalizeSettings(s) {
  const merged = { ...DEFAULT_SETTINGS, ...(isObj(s) ? s : {}) };
  merged.retry = { ...DEFAULT_SETTINGS.retry, ...(isObj(s?.retry) ? s.retry : {}) };
  merged.limits = { ...DEFAULT_SETTINGS.limits, ...(isObj(s?.limits) ? s.limits : {}) };
  merged.retention = { ...DEFAULT_SETTINGS.retention, ...(isObj(s?.retention) ? s.retention : {}) };
  merged.failureNotification = { ...DEFAULT_SETTINGS.failureNotification, ...(isObj(s?.failureNotification) ? s.failureNotification : {}) };
  merged.dataScopes = Array.isArray(merged.dataScopes) ? [...new Set(merged.dataScopes.map(String))] : [];
  return merged;
}

const MAX_NODES = 60;
const MAX_EDGES = 200;

/**
 * Pure structural validation (SOW §34). Returns { valid, errors[], warnings[] }
 * where every entry is { code, message, node? }. Async checks that need the
 * database (recipient membership, credential existence, publisher scopes) are in
 * service.js and reuse these results.
 */
export function validateWorkflowDefinition(def) {
  const errors = []; const warnings = [];
  const err = (code, message, node) => errors.push({ code, message, ...(node ? { node } : {}) });
  const warn = (code, message, node) => warnings.push({ code, message, ...(node ? { node } : {}) });
  const nodes = def?.nodes; const edges = def?.edges;
  if (!Array.isArray(nodes) || !nodes.length) { err("NO_NODES", "The workflow has no nodes."); return { valid: false, errors, warnings }; }
  if (!Array.isArray(edges)) { err("BAD_EDGES", "edges must be a list."); return { valid: false, errors, warnings }; }
  if (nodes.length > MAX_NODES) err("TOO_MANY_NODES", `A workflow may have at most ${MAX_NODES} nodes.`);
  if (edges.length > MAX_EDGES) err("TOO_MANY_EDGES", `A workflow may have at most ${MAX_EDGES} connections.`);

  const byKey = new Map();
  for (const n of nodes) {
    if (!isObj(n) || !NODE_KEY_RE.test(n.key || "")) { err("BAD_KEY", `Node key "${n?.key}" is invalid: use a letter followed by letters, numbers or _ (max 40).`, n?.key); continue; }
    if (byKey.has(n.key)) { err("DUPLICATE_KEY", `Two nodes share the key "${n.key}".`, n.key); continue; }
    byKey.set(n.key, n);
    const type = NODE_TYPES[n.type];
    if (!type) { err("UNSUPPORTED_NODE", `Node "${n.key}" has an unsupported type "${n.type}".`, n.key); continue; }
    if (n.config !== undefined && !isObj(n.config)) { err("BAD_CONFIG", `Node "${n.key}" config must be an object.`, n.key); continue; }
    if (JSON.stringify(n.config || {}).length > 32000) { err("CONFIG_TOO_LARGE", `Node "${n.key}" config is too large.`, n.key); continue; }
    if (n.disabled) continue; // a disabled step is not part of the run, so its configuration is not validated
    const cerrs = [];
    try { type.validate(n.config || {}, cerrs, n); } catch (ex) { cerrs.push(ex.message); }
    for (const m of cerrs) err("INVALID_NODE", `${n.name || n.key}: ${m}`, n.key);
    if (JSON.stringify(n.config || {}).match(/(secret|password|api[_-]?key|token|bearer)["']?\s*:\s*["'][^"']{6,}/i)) err("RAW_SECRET", `Node "${n.key}" appears to contain a raw secret. Store it as a credential and reference credentialId.`, n.key);
  }

  const active = nodes.filter((n) => n?.key && byKey.has(n.key) && !n.disabled);
  const triggers = active.filter((n) => NODE_TYPES[n.type]?.category === "trigger");
  if (triggers.length === 0) err("NO_TRIGGER", "The workflow needs exactly one enabled trigger.");
  if (triggers.length > 1) err("MULTIPLE_TRIGGERS", `The workflow has ${triggers.length} enabled triggers; use exactly one.`);

  const seenEdges = new Set();
  const out = new Map(); const inc = new Map();
  for (const e of edges) {
    const from = byKey.get(e?.from); const to = byKey.get(e?.to);
    if (!from || !to) { err("BAD_CONNECTION", `A connection references a missing node (${e?.from} → ${e?.to}).`); continue; }
    if (e.from === e.to) { err("SELF_LOOP", `Node "${e.from}" is connected to itself.`, e.from); continue; }
    const fromDef = NODE_TYPES[from.type]; const toDef = NODE_TYPES[to.type];
    const port = e.fromPort || "out";
    if (fromDef && !fromDef.ports.includes(port)) err("BAD_PORT", `Node "${e.from}" has no output "${port}".`, e.from);
    if (toDef?.category === "trigger") err("INTO_TRIGGER", `A trigger ("${e.to}") cannot receive input.`, e.to);
    const id = `${e.from}:${port}>${e.to}`;
    if (seenEdges.has(id)) { err("DUPLICATE_CONNECTION", `Duplicate connection ${e.from} → ${e.to}.`); continue; }
    seenEdges.add(id);
    if (!out.has(e.from)) out.set(e.from, []); out.get(e.from).push({ to: e.to, port });
    if (!inc.has(e.to)) inc.set(e.to, []); inc.get(e.to).push({ from: e.from, port });
  }

  // cycles (DAG only -- loops are not supported, which is also the runaway-loop control)
  const state = new Map();
  const dfs = (k, path) => {
    state.set(k, 1);
    for (const { to } of out.get(k) || []) {
      if (state.get(to) === 1) { err("CYCLE", `The workflow loops back on itself (${[...path, k, to].join(" → ")}). Loops are not supported.`, to); return; }
      if (!state.get(to)) dfs(to, [...path, k]);
    }
    state.set(k, 2);
  };
  for (const k of byKey.keys()) if (!state.get(k)) dfs(k, []);

  // reachability from the trigger (disconnected / unreachable nodes)
  if (triggers.length === 1 && !errors.some((x) => x.code === "CYCLE")) {
    const seen = new Set([triggers[0].key]); const q = [triggers[0].key];
    while (q.length) { const k = q.shift(); for (const { to } of out.get(k) || []) if (!seen.has(to)) { seen.add(to); q.push(to); } }
    for (const n of active) if (!seen.has(n.key)) err("DISCONNECTED_NODE", `"${n.name || n.key}" is not connected to the trigger, so it would never run.`, n.key);
  }
  // enabled nodes fed only by a disabled node
  for (const n of active) {
    const def = NODE_TYPES[n.type];
    if (!def || def.category === "trigger") continue;
    const ins = inc.get(n.key) || [];
    if (ins.length && ins.every((i) => byKey.get(i.from)?.disabled)) warn("FED_BY_DISABLED", `"${n.name || n.key}" only receives input from disabled nodes.`, n.key);
    if (!ins.length && !errors.some((x) => x.code === "DISCONNECTED_NODE" && x.node === n.key)) err("DISCONNECTED_NODE", `"${n.name || n.key}" has no incoming connection.`, n.key);
  }
  // conditions: must route somewhere; constant conditions have an unreachable branch
  for (const n of active.filter((x) => x.type === "condition.if")) {
    const outs = out.get(n.key) || [];
    if (!outs.length) err("CONDITION_NO_BRANCH", `Condition "${n.name || n.key}" has no outgoing branch.`, n.key);
    if (outs.length && !outs.some((o) => o.port === "true")) warn("NO_TRUE_BRANCH", `Condition "${n.name || n.key}" has no "yes" branch; a true result does nothing.`, n.key);
    if (String(n.config?.expression || "").trim().match(/^(true|false)$/i)) warn("CONSTANT_CONDITION", `Condition "${n.name || n.key}" is a constant, so one branch is unreachable.`, n.key);
  }
  // expressions reference existing node keys
  const keys = new Set(byKey.keys());
  for (const n of active) {
    const text = JSON.stringify(n.config || {});
    for (const m of text.matchAll(/nodes\.([A-Za-z][A-Za-z0-9_]*)/g)) if (!keys.has(m[1])) err("UNKNOWN_NODE_REFERENCE", `"${n.name || n.key}" refers to a node "${m[1]}" that does not exist.`, n.key);
  }
  // declared scopes must cover the nodes used
  const settings = normalizeSettings(def?.settings);
  for (const n of active) {
    const sc = NODE_TYPES[n.type]?.scope;
    if (sc && !settings.dataScopes.includes(sc)) err("SCOPE_NOT_DECLARED", `"${n.name || n.key}" needs the "${sc}" data scope, which the workflow does not declare in its permissions.`, n.key);
  }
  for (const s of settings.dataScopes) if (!DATA_SCOPES.includes(s)) err("UNKNOWN_SCOPE", `Unknown data scope "${s}".`);
  if (JSON.stringify(def).length > 400000) err("TOO_LARGE", "The workflow definition is too large.");
  return { valid: errors.length === 0, errors, warnings, nodeCount: nodes.length, edgeCount: edges.length, functions: EXPRESSION_FUNCTIONS.length };
}

/** Highest action risk in the definition (for the risk badge and template listings). */
export function definitionRisk(def) {
  let max = 0;
  for (const n of def?.nodes || []) { const r = RISK_CLASSES.indexOf(NODE_TYPES[n.type]?.risk || "read"); if (r > max) max = r; }
  return RISK_CLASSES[max];
}

export function requiredScopes(def) {
  return [...new Set((def?.nodes || []).filter((n) => !n.disabled).map((n) => NODE_TYPES[n.type]?.scope).filter(Boolean))];
}
