// src/lib/workflows/reports.js
//
// SOW §42: workflow-generated reports. A report is assembled from what the run
// already produced (data nodes, KPI snapshot, AI structured output, approvals),
// so it adds no new data access. It carries period, generated time, organization,
// source data, KPI values, change from the previous period (from the existing
// insights comparison), the AI summary, alerts, recommended actions and
// evidence references. It contains counts and headline figures, not raw records.

import { REPORT_TYPES } from "./nodes.js";
import { summarize } from "./common.js";

const TITLES = {
  daily_operations: "Daily Operations Report", weekly_operations: "Weekly Operations Report", urgent_alert: "Urgent Alert",
  executive_summary: "Executive Summary", finance_exception: "Finance Exception Report", support: "Support Report",
  inventory: "Inventory Report", trust_security: "Trust & Security Report", simulation_impact: "Simulation Impact Report",
};

const money = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 }) : "n/a");

export function buildReport({ reportType = "daily_operations", title = null, orgName, outputs, workflow, executionId, mode }) {
  if (!REPORT_TYPES.includes(reportType)) reportType = "daily_operations";
  const by = (pred) => Object.entries(outputs).find(([, v]) => pred(v.type, v.output))?.[1]?.output;
  const kpi = by((t) => t === "kpi.snapshot")?.snapshot || null;
  const ai = by((t) => t === "ai.agent") || null;
  const invoices = by((t, o) => t === "data.overdue_invoices" && o);
  const tasks = by((t) => t === "data.employee_tasks");
  const crm = by((t) => t === "data.crm_sales");
  const support = by((t) => t === "data.support_tickets" || t === "data.inaya_support_tickets");
  const inventory = by((t) => t === "data.inventory");
  const trust = by((t) => t === "data.trust_health");
  const security = by((t) => t === "data.security_events");
  const backup = by((t) => t === "data.backup_status");
  const sim = by((t) => t === "simulation.twin")?.simulation;
  const approvals = Object.values(outputs).filter((v) => v.type === "action.propose").map((v) => v.output);

  const kpiValues = {};
  if (invoices) kpiValues.overdueInvoices = { count: invoices.count, total: invoices.totalOverdue, over10k: invoices.over10k };
  if (tasks) kpiValues.taskBacklog = { open: tasks.openCount, overdue: tasks.overdueCount, blocked: tasks.blockedCount };
  if (crm) kpiValues.salesPipeline = { openDeals: crm.totals?.openDeals, openValue: crm.totals?.openPipelineValue, wonValue: crm.totals?.wonValue };
  if (support) kpiValues.supportBacklog = { open: support.openCount, urgent: support.urgentCount, slaBreached: support.slaBreachedCount };
  if (inventory) kpiValues.inventoryExceptions = { lowStock: inventory.totals?.lowStock };
  if (trust) kpiValues.trustHealth = { overall: trust.overall, score: trust.score };
  if (security) kpiValues.securityHealth = { aiBlocked: security.aiBlocked, nasThreats: security.nasThreatCount };
  if (backup) kpiValues.storageIntegrity = { failedBackups30d: backup.failedNasBackups30d };
  if (kpi?.kpis) kpiValues.businessKpis = kpi.kpis;

  const alerts = [...(kpi?.alerts || []).slice(0, 10)];
  const aiFindings = ai?.result?.findings || [];
  const recommended = ai?.result?.recommendations || [];

  const report = {
    reportType, title: title || TITLES[reportType], mode,
    period: kpi?.period || { label: "current period" },
    generatedAt: new Date().toISOString(), organization: orgName || null,
    sourceData: Object.entries(outputs).filter(([, v]) => v.type?.startsWith("data.") || v.type === "http.request").map(([k, v]) => ({ node: k, type: v.type, summary: summarize(v.output) })),
    kpiValues,
    changeFromPreviousPeriod: kpi?.comparison || null,
    aiSummary: ai?.result ? { summary: ai.result.summary, classification: ai.result.classification, urgent: ai.result.urgent, confidence: ai.result.confidence, model: ai.model } : null,
    alerts, findings: aiFindings, recommendedActions: recommended,
    approvals: approvals.map((a) => ({ tool: a?.tool, status: a?.approvalStatus || a?.status, requestId: a?.requestId })),
    simulation: sim ? { scenario: sim.scenario, resultStatus: sim.resultStatus, integrityHash: sim.integrityHash, impact: sim.directImpact } : null,
    evidenceReferences: { workflowId: workflow.id, workflowVersion: workflow.version, executionId },
  };

  const lines = [`# ${report.title}`, `Organization: ${report.organization || "n/a"}  |  Generated: ${report.generatedAt}  |  Period: ${report.period.label}${mode !== "production" ? `  |  **${mode.toUpperCase()} MODE**` : ""}`, ""];
  if (report.aiSummary) lines.push("## Summary", `${report.aiSummary.summary}`, `Classification: ${report.aiSummary.classification}${report.aiSummary.urgent ? " (urgent)" : ""}, confidence ${report.aiSummary.confidence}`, "");
  const kv = [];
  if (kpiValues.overdueInvoices) kv.push(`- Overdue invoices: ${kpiValues.overdueInvoices.count} totalling ${money(kpiValues.overdueInvoices.total)}`);
  if (kpiValues.taskBacklog) kv.push(`- Tasks: ${kpiValues.taskBacklog.open} open, ${kpiValues.taskBacklog.overdue} overdue, ${kpiValues.taskBacklog.blocked} blocked`);
  if (kpiValues.salesPipeline) kv.push(`- Sales pipeline: ${kpiValues.salesPipeline.openDeals} open deals worth ${money(kpiValues.salesPipeline.openValue)}`);
  if (kpiValues.supportBacklog) kv.push(`- Support: ${kpiValues.supportBacklog.open} open, ${kpiValues.supportBacklog.urgent} urgent`);
  if (kpiValues.inventoryExceptions) kv.push(`- Inventory: ${kpiValues.inventoryExceptions.lowStock} low-stock products`);
  if (kpiValues.trustHealth) kv.push(`- Trust health: ${kpiValues.trustHealth.overall ?? "n/a"}`);
  if (kv.length) lines.push("## Key figures", ...kv, "");
  if (aiFindings.length) lines.push("## Findings", ...aiFindings.map((f) => `- [${f.severity}] ${f.title}`), "");
  if (recommended.length) lines.push("## Recommended actions", ...recommended.map((r) => `- ${r.action}${r.risk && r.risk !== "read" ? ` (${r.risk} risk: needs approval)` : ""}`), "");
  if (report.approvals.length) lines.push("## Approvals", ...report.approvals.map((a) => `- ${a.tool}: ${a.status}`), "");
  lines.push(`Evidence: workflow ${workflow.id} v${workflow.version}, execution ${executionId}`);
  return { report, markdown: lines.join("\n") };
}
