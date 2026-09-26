// src/lib/workflows/templates.js
//
// SOW §41, §54: the initial template library. Templates are ordinary workflow
// definitions (same schema as the visual editor), so creating one just copies
// it into a DRAFT for the organization: nothing runs until the user reviews and
// publishes it. Steps that need an integration the organization may not have
// (Slack, a helpdesk) ship DISABLED with the requirement listed, never as a
// silently broken step.

import { definitionRisk, requiredScopes, scopeHeld } from "./nodes.js";

const n = (key, type, name, x, y, config = {}, extra = {}) => ({ key, type, name, position: { x, y }, config, ...extra });
const e = (from, to, fromPort = "out") => ({ from, to, fromPort });

const AI_URGENT_EXPR = "(nodes.agent.output.result.urgent == true and nodes.agent.output.result.confidence >= 0.5) or nodes.agent.output.deterministic.anyExceeded == true";
const DAILY_SCHEDULE = { kind: "daily", time: "08:00", timezone: "UTC", enabled: true };

const SETTINGS = (scopes, extra = {}) => ({ dataScopes: scopes, ...extra });

function dailyBusinessHealth() {
  return {
    nodes: [
      n("trigger", "trigger.schedule", "Daily Schedule Trigger", 40, 260, { schedule: DAILY_SCHEDULE }),
      n("crm", "data.crm_sales", "Get CRM / Sales Data", 300, 40, { limit: 100 }),
      n("support", "data.support_tickets", "Get Support Tickets", 300, 180, { url: "https://helpdesk.example.com/api/tickets", allowedHosts: ["helpdesk.example.com"], rowsPath: "tickets", method: "GET" }, { disabled: true, note: "Needs your helpdesk API (Inaya has no ticketing module). Enable after setting the URL and a credential." }),
      n("invoices", "data.overdue_invoices", "Get Overdue Invoices", 300, 320, { limit: 100 }),
      n("tasks", "data.employee_tasks", "Get Employee Tasks", 300, 460, { limit: 100 }),
      n("merge", "transform.merge", "Merge Business Data", 560, 260, {}),
      n("kpi", "kpi.snapshot", "Build KPI Snapshot", 800, 260, { periodDays: 30 }),
      n("agent", "ai.agent", "AI Operations Manager Agent", 1040, 260, {
        model: "gemini-3.5-flash-lite", temperature: 0.2, maxOutputTokens: 1024, maxToolCalls: 2,
        systemInstructions: "Review today's operating data for a business owner. Flag anything that needs attention today, explain why in one or two sentences each, and recommend next steps. Be concrete and use the figures given.",
        thresholds: [
          { name: "Overdue invoices over 10,000", expression: "nodes.kpi.output.snapshot.overdueInvoices.total", op: ">", value: 10000 },
          { name: "Overdue tasks", expression: "nodes.kpi.output.snapshot.taskBacklog.overdue", op: ">", value: 10 },
        ],
        tools: ["read_invoices", "read_tasks", "read_crm"], memory: { enabled: true, maxItems: 3 }, inputFrom: ["kpi"],
      }),
      n("urgent", "condition.if", "Urgent Problem Found?", 1300, 260, { expression: AI_URGENT_EXPR }),
      n("urgentAlert", "notify.inaya", "Urgent alert (Inaya)", 1560, 100, { title: "Urgent: {{ nodes.agent.output.result.classification }} issue found", body: "{{ nodes.agent.output.result.summary }}", severity: "critical", audience: "managers", alertType: "urgent" }),
      n("urgentEmail", "notify.email", "Urgent email", 1560, 220, { title: "Urgent business alert", body: "{{ nodes.agent.output.result.summary }}", severity: "critical", recipients: [], audience: "managers", alertType: "urgent_email" }),
      n("urgentSlack", "notify.slack", "Urgent Slack alert", 1560, 340, { title: "Urgent business alert", body: "{{ nodes.agent.output.result.summary }}", severity: "critical", alertType: "urgent_slack", credentialId: null }, { disabled: true, note: "Needs a Slack webhook credential." }),
      n("report", "action.report", "Daily report", 1560, 480, { reportType: "daily_operations" }),
      n("dailyInaya", "notify.inaya", "Daily report (Inaya)", 1820, 480, { title: "Daily operations report", body: "{{ nodes.agent.output.result.summary }}", severity: "info", audience: "managers", alertType: "daily" }),
    ],
    edges: [
      e("trigger", "crm"), e("trigger", "support"), e("trigger", "invoices"), e("trigger", "tasks"),
      e("crm", "merge"), e("support", "merge"), e("invoices", "merge"), e("tasks", "merge"),
      e("merge", "kpi"), e("kpi", "agent"), e("agent", "urgent"),
      e("urgent", "urgentAlert", "true"), e("urgent", "urgentEmail", "true"), e("urgent", "urgentSlack", "true"),
      e("urgent", "report", "false"), e("report", "dailyInaya"),
    ],
    settings: SETTINGS(["crm", "finance", "tasks", "insights", "ai", "notify", "external_http"], { failureNotification: { enabled: true, recipients: [] } }),
  };
}

function financeExceptionMonitor() {
  return {
    nodes: [
      n("trigger", "trigger.schedule", "Schedule", 40, 160, { schedule: { ...DAILY_SCHEDULE, time: "07:30" } }),
      n("invoices", "data.overdue_invoices", "Overdue invoices", 300, 160, { limit: 200, minAmount: 1000 }),
      n("check", "condition.if", "Threshold check", 560, 160, { expression: "nodes.invoices.output.over10k > 0 or nodes.invoices.output.totalOverdue > 25000" }),
      n("agent", "ai.agent", "AI classification", 820, 80, { maxToolCalls: 0, systemInstructions: "Classify the overdue-invoice exposure and recommend collection steps.", thresholds: [{ name: "Total overdue", expression: "nodes.invoices.output.totalOverdue", op: ">", value: 25000 }], inputFrom: ["invoices"] }),
      n("urgent", "condition.if", "Urgent?", 1080, 80, { expression: AI_URGENT_EXPR }),
      n("alert", "notify.inaya", "Finance alert", 1340, 40, { title: "Finance exception: overdue invoices", body: "{{ nodes.agent.output.result.summary }}", severity: "critical", audience: "managers", alertType: "finance_urgent" }),
      n("note", "evidence.record", "Evidence", 1340, 160, { note: "Finance exception reviewed: total overdue {{ nodes.invoices.output.totalOverdue }}" }),
    ],
    edges: [e("trigger", "invoices"), e("invoices", "check"), e("check", "agent", "true"), e("agent", "urgent"), e("urgent", "alert", "true"), e("urgent", "note", "false")],
    settings: SETTINGS(["finance", "ai", "notify", "evidence"]),
  };
}

function supportEscalation() {
  return {
    nodes: [
      n("trigger", "trigger.schedule", "Schedule", 40, 160, { schedule: { kind: "interval", everyMinutes: 60, timezone: "UTC", enabled: true } }),
      n("support", "data.support_tickets", "Support tickets", 300, 160, { url: "https://helpdesk.example.com/api/tickets", allowedHosts: ["helpdesk.example.com"], rowsPath: "tickets", method: "GET" }, { disabled: true, note: "Needs your helpdesk API URL and credential." }),
      n("sla", "transform.filter", "SLA check", 560, 160, { input: "support", expression: "row.slaBreached == true or row.priority == 'urgent'" }),
      n("urgent", "condition.if", "Urgent?", 820, 160, { expression: "count(nodes.sla.output) > 0" }),
      n("escalate", "notify.inaya", "Escalation", 1080, 100, { title: "Support escalation: {{ count(nodes.sla.output) }} tickets at risk", body: "Tickets breaching SLA or marked urgent need attention.", severity: "critical", audience: "managers", alertType: "support_escalation" }),
      n("note", "evidence.record", "Evidence", 1080, 240, { note: "Support queue checked: {{ count(nodes.sla.output) }} at risk" }),
    ],
    edges: [e("trigger", "support"), e("support", "sla"), e("sla", "urgent"), e("urgent", "escalate", "true"), e("urgent", "note", "false")],
    settings: SETTINGS(["external_http", "notify", "evidence"]),
  };
}

function inventoryRisk() {
  return {
    nodes: [
      n("trigger", "trigger.schedule", "Schedule", 40, 200, { schedule: { ...DAILY_SCHEDULE, time: "06:30" } }),
      n("inventory", "data.inventory", "Inventory", 300, 80, {}),
      n("procurement", "data.procurement", "Procurement", 300, 200, { limit: 100 }),
      n("sales", "data.crm_sales", "Sales demand", 300, 320, { limit: 100 }),
      n("merge", "transform.merge", "Merge", 560, 200, {}),
      n("kpi", "kpi.snapshot", "KPI calculation", 800, 200, { periodDays: 30 }),
      n("agent", "ai.agent", "AI analysis", 1040, 200, { maxToolCalls: 0, systemInstructions: "Assess stock-out risk given low-stock items, open purchase orders and sales demand. Recommend what to reorder.", inputFrom: ["kpi"], thresholds: [{ name: "Low-stock products", expression: "nodes.inventory.output.totals.lowStock", op: ">", value: 3 }] }),
      n("risk", "condition.if", "At risk?", 1300, 200, { expression: AI_URGENT_EXPR }),
      n("alert", "notify.inaya", "Risk notification", 1560, 160, { title: "Inventory risk", body: "{{ nodes.agent.output.result.summary }}", severity: "warning", audience: "managers", alertType: "inventory_risk" }),
    ],
    edges: [e("trigger", "inventory"), e("trigger", "procurement"), e("trigger", "sales"), e("inventory", "merge"), e("procurement", "merge"), e("sales", "merge"), e("merge", "kpi"), e("kpi", "agent"), e("agent", "risk"), e("risk", "alert", "true")],
    settings: SETTINGS(["inventory", "procurement", "crm", "insights", "ai", "notify"]),
  };
}

function trustSecurityOps() {
  return {
    nodes: [
      n("trigger", "trigger.schedule", "Schedule", 40, 220, { schedule: { ...DAILY_SCHEDULE, time: "06:00" } }),
      n("trust", "data.trust_health", "Trust health", 300, 80, {}),
      n("security", "data.security_events", "Security events", 300, 220, { days: 7 }),
      n("backup", "data.backup_status", "Backup / integrity", 300, 360, {}),
      n("merge", "transform.merge", "Merge", 560, 220, {}),
      n("agent", "ai.agent", "AI summary", 800, 220, { maxToolCalls: 0, inputFrom: ["merge"], systemInstructions: "Summarize the organization's trust, security and backup posture for an administrator.", thresholds: [{ name: "Failed backups (30d)", expression: "nodes.backup.output.failedNasBackups30d", op: ">", value: 0 }, { name: "AI requests blocked (7d)", expression: "nodes.security.output.aiBlocked", op: ">", value: 10 }] }),
      n("alertIf", "condition.if", "Threshold crossed?", 1060, 220, { expression: AI_URGENT_EXPR }),
      n("alert", "notify.inaya", "Alert", 1320, 160, { title: "Trust / security alert", body: "{{ nodes.agent.output.result.summary }}", severity: "critical", audience: "managers", alertType: "trust_security" }),
      n("note", "evidence.record", "Evidence", 1320, 300, { note: "Trust and security posture reviewed" }),
    ],
    edges: [e("trigger", "trust"), e("trigger", "security"), e("trigger", "backup"), e("trust", "merge"), e("security", "merge"), e("backup", "merge"), e("merge", "agent"), e("agent", "alertIf"), e("alertIf", "alert", "true"), e("alertIf", "note", "false")],
    settings: SETTINGS(["trust", "security", "backup", "ai", "notify", "evidence"]),
  };
}

function digitalTwinDecisionReview() {
  return {
    nodes: [
      n("trigger", "trigger.manual", "Manual trigger", 40, 160, {}),
      n("sim", "simulation.twin", "Digital Twin simulation", 300, 160, { scenarioType: "SUPPLIER_UNAVAILABLE", entityName: "{{ trigger.supplier }}" }),
      n("agent", "ai.agent", "AI explanation", 560, 160, { maxToolCalls: 0, inputFrom: ["sim"], systemInstructions: "Explain the simulated impact in plain language and recommend a decision. This is a simulation: nothing has changed." }),
      n("report", "action.report", "Decision summary", 820, 160, { reportType: "simulation_impact" }),
      n("notify", "notify.inaya", "Send to managers", 1080, 160, { title: "Simulation impact report", body: "{{ nodes.agent.output.result.summary }}", severity: "info", audience: "managers", alertType: "twin_review" }),
    ],
    edges: [e("trigger", "sim"), e("sim", "agent"), e("agent", "report"), e("report", "notify")],
    settings: SETTINGS(["twin", "ai", "notify"]),
  };
}

function notificationTest() {
  const body = "This is a test message from Inaya Automations. If you can read it, delivery works. Sent {{ now }}.";
  return {
    nodes: [
      n("trigger", "trigger.manual", "Run this test", 40, 160, {}),
      n("inaya", "notify.inaya", "In-app notification", 320, 40, { title: "Inaya notification test", body, severity: "info", audience: "managers", alertType: "delivery_test" }),
      n("slack", "notify.slack", "Slack message", 320, 160, { title: "Inaya Slack test", body, severity: "info", credentialId: null, alertType: "delivery_test_slack" }, { disabled: true, note: "Pick your Slack webhook credential, then clear Disabled." }),
      n("gmail", "notify.gmail", "Gmail message", 320, 280, { title: "Inaya Gmail test", body, severity: "info", recipients: [], credentialId: null, alertType: "delivery_test_gmail" }, { disabled: true, note: "Add your own email as the recipient, pick your Gmail credential, then clear Disabled." }),
    ],
    edges: [e("trigger", "inaya"), e("trigger", "slack"), e("trigger", "gmail")],
    settings: SETTINGS(["notify"]),
  };
}

const T = [
  { id: "daily-business-health", name: "Daily Business Health", category: "Operations", description: "Every morning: CRM, support, overdue invoices and tasks → KPI snapshot → AI Operations Manager → urgent alert or daily report.", requiredIntegrations: ["helpdesk (optional)", "Slack (optional)"], build: dailyBusinessHealth },
  { id: "finance-exception-monitor", name: "Finance Exception Monitor", category: "Finance", description: "Watch overdue invoices against thresholds, classify with AI, alert managers when urgent.", requiredIntegrations: [], build: financeExceptionMonitor },
  { id: "support-escalation", name: "Support Escalation", category: "Support", description: "Check the helpdesk for SLA breaches and urgent tickets and escalate.", requiredIntegrations: ["helpdesk"], build: supportEscalation },
  { id: "inventory-risk", name: "Inventory Risk", category: "Supply chain", description: "Combine inventory, procurement and sales demand and warn about stock-out risk.", requiredIntegrations: [], build: inventoryRisk },
  { id: "trust-security-operations", name: "Trust / Security Operations", category: "Security", description: "Daily trust health, security events and backup integrity summary with alerts.", requiredIntegrations: [], build: trustSecurityOps },
  { id: "notification-test", name: "Notification Delivery Test", category: "Setup", description: "Sends one test message to the in-app inbox, Slack and Gmail so you can confirm delivery before relying on an alert. Slack and Gmail steps start disabled until you attach a credential.", requiredIntegrations: ["Slack webhook (optional)", "Gmail (optional)"], build: notificationTest },
  { id: "digital-twin-decision-review", name: "Digital Twin Decision Review", category: "Planning", description: "Run a read-only supplier-unavailable simulation, explain the impact and send it to managers.", requiredIntegrations: [], build: digitalTwinDecisionReview },
];

export function buildTemplateDefinition(id) {
  const t = T.find((x) => x.id === id);
  return t ? t.build() : null;
}

/** Templates the current member may actually use (SOW §54: no templates that ask for scopes they lack). */
export function listTemplates({ membership = null } = {}) {
  return T.map((t) => {
    const def = t.build();
    const scopes = requiredScopes(def);
    const usable = membership ? scopes.every((sc) => scopeHeld(membership, sc)) : true;
    return { id: t.id, name: t.name, description: t.description, category: t.category, requiredPermissions: scopes, requiredIntegrations: t.requiredIntegrations, riskLevel: definitionRisk(def), version: "1.0", author: "Inaya", verification: "Inaya-authored; structure validated by the workflow validator; Slack/helpdesk steps ship disabled and unverified", nodeCount: def.nodes.length, usable };
  }).filter((t) => t.usable);
}
