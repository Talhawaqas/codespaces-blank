// src/lib/workflows/tools.js
//
// SOW §15, §36, §37: the workflow tool registry. The AI agent can call ONLY
// tools listed here AND enabled on that agent node, and every gate that matters
// is enforced in this file, outside the model:
//   - the tool name must exist in TOOLS and be in the node's allowlist (the model
//     never chooses "any" tool, and never supplies a URL: no tool takes one);
//   - arguments are validated against the tool's own inputSchema (unknown keys,
//     wrong types, out-of-range values are refused);
//   - the executing identity must hold the tool's data scope (live membership);
//   - mutating tools are simulated in test / dry-run mode; the only path to a
//     consequential change is create_approval_request -> the existing
//     controlled-action system (never a direct write);
//   - every invocation, including a refused one, is recorded (name, argument
//     fingerprint, decision) without the model's reasoning.

import { createHash } from "node:crypto";
import { Type } from "@google/genai";
import { runBusinessTool } from "../ai-business-tools.js";
import { simulateDigitalTwinScenario, SCENARIO_TYPES } from "../digitalTwinSimulate.js";
import { getOrgCollections, toObjectId } from "../orgs.js";
import { runDataNode } from "./data.js";
import { scopeHeld, APPROVED_PROPOSE_TOOLS } from "./nodes.js";
import { runNotifyNode } from "./notify.js";
import { bounded, redact } from "./common.js";

const IDENTIFIER_ARG = {
  propose_task_status_change: "taskTitle", propose_invoice_decision: "invoiceNumber", propose_purchase_order_transition: "supplierName",
  propose_purchase_request_transition: "requestTitle", propose_deal_transition: "dealTitle", propose_leave_decision: "employeeName", propose_expense_decision: "expenseVendor",
};

/** Submits a change proposal through the EXISTING guarded-action path and returns the request (SOW §40: no parallel approval engine). */
export async function submitApprovalRequest({ tool, args, dataCtx, since }) {
  if (!APPROVED_PROPOSE_TOOLS.includes(tool)) return { error: `"${tool}" is not an approvable workflow action.` };
  const res = await runBusinessTool(tool, args, dataCtx.bc);
  if (res?.error) return { error: res.error };
  if (res?.notFound || res?.ambiguous) return { error: res.ambiguous ? "More than one record matched; be more specific." : "No matching record was found in the records this identity may access." };
  const { aiActionRequests } = await getOrgCollections();
  const request = await aiActionRequests.find({ orgId: toObjectId(dataCtx.orgId), toolName: tool, requestedByEmail: dataCtx.email, requestedAt: { $gte: since } }).sort({ requestedAt: -1 }).limit(1).toArray();
  return { submitted: true, deduped: !!res.deduped, requestId: request[0] ? String(request[0]._id) : null, status: request[0]?.status || "PENDING_APPROVAL", message: res.message };
}

const fp = (o) => createHash("sha256").update(JSON.stringify(o ?? null)).digest("hex").slice(0, 16);

const S = (extra = {}) => ({ type: "string", maxLength: 200, ...extra });
export const TOOLS = {
  read_crm: { description: "Read the CRM/sales pipeline summary the executing user may see.", inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 50 } } }, outputSchema: "object: deals[], totals", requiredPermission: "crm", riskLevel: "read", readOnly: true, run: (a, c) => runDataNode("data.crm_sales", { limit: a.limit || 25 }, c.dataCtx) },
  read_invoices: { description: "Read overdue invoices the executing user may see.", inputSchema: { type: "object", properties: { minAmount: { type: "number", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 50 } } }, outputSchema: "object: invoices[], count, totalOverdue", requiredPermission: "finance", riskLevel: "read", readOnly: true, run: (a, c) => runDataNode("data.overdue_invoices", { minAmount: a.minAmount || 0, limit: a.limit || 25 }, c.dataCtx) },
  read_tasks: { description: "Read open and overdue tasks the executing user may see.", inputSchema: { type: "object", properties: { onlyOverdue: { type: "boolean" }, limit: { type: "integer", minimum: 1, maximum: 50 } } }, outputSchema: "object: tasks[], counts", requiredPermission: "tasks", riskLevel: "read", readOnly: true, run: (a, c) => runDataNode("data.employee_tasks", { onlyOverdue: !!a.onlyOverdue, limit: a.limit || 25 }, c.dataCtx) },
  read_support: { description: "Read the support-ticket data this workflow already fetched (it cannot call any URL).", inputSchema: { type: "object", properties: {} }, outputSchema: "the upstream support node's output", requiredPermission: "external_http", riskLevel: "read", readOnly: true, run: async (a, c) => { const k = Object.keys(c.results || {}).find((x) => c.nodeTypes?.[x] === "data.support_tickets"); return k ? c.results[k] : { error: "This workflow has no support-ticket node." }; } },
  read_inventory: { description: "Read low-stock and inventory exceptions.", inputSchema: { type: "object", properties: {} }, outputSchema: "object: lowStockProducts[], totals", requiredPermission: "inventory", riskLevel: "read", readOnly: true, run: (a, c) => runDataNode("data.inventory", {}, c.dataCtx) },
  read_procurement: { description: "Read purchase orders and requests the executing user may see.", inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 50 } } }, outputSchema: "object: purchaseOrders[], totals", requiredPermission: "procurement", riskLevel: "read", readOnly: true, run: (a, c) => runDataNode("data.procurement", { limit: a.limit || 25 }, c.dataCtx) },
  read_trust_health: { description: "Read the organization's Trust Health summary.", inputSchema: { type: "object", properties: {} }, outputSchema: "object: overall, dimensions", requiredPermission: "trust", riskLevel: "read", readOnly: true, run: (a, c) => runDataNode("data.trust_health", {}, c.dataCtx) },
  read_security_status: { description: "Read recent AI-security and NAS threat events.", inputSchema: { type: "object", properties: { days: { type: "integer", minimum: 1, maximum: 30 } } }, outputSchema: "object: aiSecurity[], nasThreats[]", requiredPermission: "security", riskLevel: "read", readOnly: true, run: (a, c) => runDataNode("data.security_events", { days: a.days || 7 }, c.dataCtx) },
  read_evidence_graph: { description: "Read recent Evidence Graph events the executing user may see.", inputSchema: { type: "object", properties: { subjectType: S({ enum: ["INVOICE", "PURCHASE_ORDER", "PURCHASE_REQUEST", "AI_ACTION_REQUEST", "AI_SECURITY_CHECK", "GENERATED_DOCUMENT", "NAS_SHARE"] }), limit: { type: "integer", minimum: 1, maximum: 50 } } }, outputSchema: "object: events[]", requiredPermission: "evidence", riskLevel: "read", readOnly: true, run: (a, c) => runDataNode("data.evidence_events", { subjectType: a.subjectType, limit: a.limit || 25 }, c.dataCtx) },
  query_digital_twin: {
    description: "Run a read-only Digital Twin simulation (never changes production records).", inputSchema: { type: "object", properties: { scenarioType: S({ enum: SCENARIO_TYPES }), entityId: S() }, required: ["scenarioType", "entityId"] },
    outputSchema: "object: simulation", requiredPermission: "twin", riskLevel: "read", readOnly: true,
    run: (a, c) => simulateDigitalTwinScenario({ orgId: c.dataCtx.orgId, scenarioType: a.scenarioType, entityId: a.entityId, membership: c.dataCtx.membership, actorEmail: c.dataCtx.email, params: {} }),
  },
  generate_report: { description: "Assemble a short report from data already gathered in this run.", inputSchema: { type: "object", properties: { title: S() }, required: ["title"] }, outputSchema: "object: report", requiredPermission: "ai", riskLevel: "read", readOnly: true, run: async (a, c) => ({ report: { title: String(a.title).slice(0, 120), generatedAt: new Date().toISOString(), sources: Object.keys(c.results || {}) } }) },
  create_notification: {
    description: "Send an Inaya notification to organization members.", inputSchema: { type: "object", properties: { title: S(), body: S({ maxLength: 800 }), severity: S({ enum: ["info", "warning", "critical"] }), audience: S({ enum: ["managers", "all"] }), alertType: S({ maxLength: 40 }) }, required: ["title", "body"] },
    outputSchema: "object: delivered, deliveries", requiredPermission: "notify", riskLevel: "low", readOnly: false,
    run: (a, c) => runNotifyNode("notify.inaya", { title: a.title, body: a.body, severity: a.severity || "info", audience: a.audience || "managers", alertType: `ai_${(a.alertType || "alert").replace(/[^a-z0-9_.-]/gi, "").slice(0, 30)}` }, { ...c.notifyCtx, mode: c.mode }).then((r) => r.output),
  },
  create_approval_request: {
    description: "Ask a human to approve a business change. It is only PROPOSED; nothing changes until a person approves it and the standard 36-hour delay passes.",
    inputSchema: { type: "object", properties: { tool: S({ enum: APPROVED_PROPOSE_TOOLS }), identifier: S(), action: S(), note: S({ maxLength: 300 }) }, required: ["tool", "identifier", "action"] },
    outputSchema: "object: submitted, requestId, status", requiredPermission: "propose", riskLevel: "high", readOnly: false,
    run: async (a, c) => {
      const argName = IDENTIFIER_ARG[a.tool];
      if (!argName) return { error: "That is not an approvable action." };
      const args = { [argName]: a.identifier, [a.tool === "propose_expense_decision" ? "decision" : "action"]: a.action };
      return submitApprovalRequest({ tool: a.tool, args, dataCtx: c.dataCtx, since: new Date(Date.now() - 3600_000).toISOString() });
    },
  },
  create_evidence_record: { description: "Record a short evidence note for this execution.", inputSchema: { type: "object", properties: { note: S({ maxLength: 500 }) }, required: ["note"] }, outputSchema: "object: recorded", requiredPermission: "evidence", riskLevel: "low", readOnly: false, run: async (a, c) => (c.recordEvidence ? c.recordEvidence("AI_EVIDENCE_NOTE", { note: String(a.note).slice(0, 500) }) : { recorded: false }) },
};

export const TOOL_NAMES = Object.keys(TOOLS);

/** Registry view with the SOW's declared fields (also used by the editor and docs). */
export function listTools() {
  return Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema, outputSchema: t.outputSchema, requiredPermission: t.requiredPermission, riskLevel: t.riskLevel, readOnly: t.readOnly, allowedWorkflowContexts: ["ai.agent"] }));
}

/** Minimal JSON-schema-style validator for tool arguments. Returns an error string or null. */
export function validateToolArgs(schema, args) {
  if (args === undefined || args === null) args = {};
  if (typeof args !== "object" || Array.isArray(args)) return "Arguments must be an object.";
  const props = schema.properties || {};
  for (const k of Object.keys(args)) if (!(k in props)) return `Unknown argument "${k}".`;
  for (const k of schema.required || []) if (args[k] === undefined || args[k] === "") return `Missing argument "${k}".`;
  for (const [k, v] of Object.entries(args)) {
    const p = props[k];
    if (p.type === "string") { if (typeof v !== "string") return `"${k}" must be text.`; if (p.maxLength && v.length > p.maxLength) return `"${k}" is too long.`; if (p.enum && !p.enum.includes(v)) return `"${k}" must be one of ${p.enum.join(", ")}.`; }
    else if (p.type === "integer" || p.type === "number") { if (typeof v !== "number" || !Number.isFinite(v) || (p.type === "integer" && !Number.isInteger(v))) return `"${k}" must be a number.`; if (p.minimum !== undefined && v < p.minimum) return `"${k}" is too small.`; if (p.maximum !== undefined && v > p.maximum) return `"${k}" is too large.`; }
    else if (p.type === "boolean") { if (typeof v !== "boolean") return `"${k}" must be true or false.`; }
  }
  return null;
}

/** Gemini function declarations for the enabled, permitted tools. */
export function geminiDeclarations(names, membership) {
  const map = { string: Type.STRING, integer: Type.INTEGER, number: Type.NUMBER, boolean: Type.BOOLEAN };
  return names.filter((n) => TOOLS[n] && scopeHeld(membership, TOOLS[n].requiredPermission)).map((n) => {
    const t = TOOLS[n];
    const properties = {};
    for (const [k, p] of Object.entries(t.inputSchema.properties || {})) properties[k] = { type: map[p.type], ...(p.enum ? { enum: p.enum } : {}), description: k };
    return { name: n, description: t.description, parameters: { type: Type.OBJECT, properties, ...(t.inputSchema.required?.length ? { required: t.inputSchema.required } : {}) } };
  });
}

/**
 * Invokes one tool on behalf of the agent. `ctx`: { allowed:Set, declaredScopes, dataCtx, mode, results, nodeTypes, notifyCtx, log, budget, settings }.
 * NEVER throws to the model: refusals come back as { error } and are logged.
 */
export async function invokeTool(name, rawArgs, ctx) {
  const decide = async (decision, extra = {}) => { await ctx.log?.({ tool: String(name).slice(0, 60), argsFingerprint: fp(rawArgs), decision, ...extra }); };
  const tool = typeof name === "string" && Object.prototype.hasOwnProperty.call(TOOLS, name) ? TOOLS[name] : null;
  if (!tool) { await decide("DENIED_UNKNOWN_TOOL"); return { error: "That tool does not exist." }; }
  if (!ctx.allowed.has(name)) { await decide("DENIED_NOT_ENABLED"); return { error: "That tool is not enabled for this agent." }; }
  ctx.budget.tools = (ctx.budget.tools || 0) + 1;
  if (ctx.budget.tools > (ctx.settings?.limits?.maxToolCalls ?? 10)) { await decide("DENIED_BUDGET"); return { error: "The tool-call budget for this run is used up." }; }
  const argErr = validateToolArgs(tool.inputSchema, rawArgs);
  if (argErr) { await decide("DENIED_BAD_ARGUMENTS", { reason: argErr }); return { error: `Invalid arguments: ${argErr}` }; }
  if (!ctx.declaredScopes.includes(tool.requiredPermission) || !scopeHeld(ctx.dataCtx.membership, tool.requiredPermission)) { await decide("DENIED_PERMISSION", { scope: tool.requiredPermission }); return { error: "The executing user is not permitted to use that tool." }; }
  // test mode never touches real data: reads return the test dataset's synthetic value for the tool
  if (ctx.mode === "test" && tool.readOnly && name !== "generate_report") {
    await decide("SYNTHETIC", { risk: tool.riskLevel });
    return ctx.testToolData?.[name] ?? { synthetic: true, note: "No test data was supplied for this tool." };
  }
  if (!tool.readOnly && ctx.mode !== "production") {
    await decide("SIMULATED", { risk: tool.riskLevel });
    return { simulated: true, message: `In ${ctx.mode} mode "${name}" was not executed.`, wouldHaveRun: { tool: name, argsFingerprint: fp(rawArgs) } };
  }
  try {
    const out = await tool.run(rawArgs || {}, ctx);
    await decide("ALLOWED", { risk: tool.riskLevel, readOnly: tool.readOnly });
    return bounded(redact(out), 60_000);
  } catch (err) {
    await decide("FAILED", { reason: String(err.message).slice(0, 120) });
    return { error: "The tool failed." };
  }
}
