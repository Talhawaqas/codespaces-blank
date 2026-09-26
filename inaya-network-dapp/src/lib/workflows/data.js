// src/lib/workflows/data.js
//
// SOW §9, §12, §29: the workflow's data nodes. They do NOT query business
// collections with their own logic. Business records come from the same
// permission-scoped view the Business Assistant uses -- buildBusinessContext()
// -> getAccessibleScope() -- resolved from the EXECUTING identity's live
// membership, so a workflow can never read a record that identity cannot see in
// the UI (SOW §9 "must never obtain data merely because the creator can see
// it"). KPI, Business Brief, Trust Health, the Evidence Graph and the Digital
// Twin history are read through their existing modules.

import { getOrgCollections, toObjectId } from "../orgs.js";
import { canManageOrg } from "../orgGates.js";
import { buildBusinessContext } from "../ai-business-tools.js";
import { computeBusinessInsights } from "../business-insights.js";
import { generateBusinessBrief } from "../business-brief.js";
import { computeTrustHealth2 } from "../trust-health-v2.js";
import { listBusinessEvents } from "../businessEvents.js";
import { listDigitalTwinSimulations } from "../digitalTwinSimulate.js";
import { scopeHeld, NODE_TYPES } from "./nodes.js";
import { bounded } from "./common.js";

const DAY = 86400000;

/** Builds the per-execution data context from the executing identity's LIVE membership. */
export async function buildDataContext({ orgId, membership, email }) {
  const bc = await buildBusinessContext({ orgId, membership, email });
  return { orgId, membership, email, bc };
}

function cap(list, limit = 200) { return list.slice(0, Math.min(Math.max(Number(limit) || 200, 1), 500)); }
const name = (map, id) => (id ? map.get(String(id)) || "Unknown" : null);

const READERS = {
  async crm_sales(cfg, { bc }) {
    const s = bc.scope;
    const deals = s.visibleDeals.map((d) => ({ title: d.title, stage: d.status, value: Number(d.value) || 0, contactName: name(bc.contactNameById, d.contactId), departmentName: name(bc.deptNameById, d.departmentId), createdAt: d.createdAt, closedAt: d.closedAt || null }));
    const open = deals.filter((d) => !["WON", "LOST"].includes(d.stage));
    const byStage = {};
    for (const d of deals) { byStage[d.stage] = byStage[d.stage] || { count: 0, value: 0 }; byStage[d.stage].count++; byStage[d.stage].value += d.value; }
    return { deals: cap(deals, cfg.limit), totals: { deals: deals.length, contacts: s.visibleContacts.length, openDeals: open.length, openPipelineValue: open.reduce((a, d) => a + d.value, 0), wonValue: deals.filter((d) => d.stage === "WON").reduce((a, d) => a + d.value, 0), byStage } };
  },

  async overdue_invoices(cfg, { bc }) {
    const now = Date.now();
    const min = Number(cfg.minAmount) || 0;
    const rows = bc.scope.visibleInvoices
      .filter((i) => (i.status === "OVERDUE" || (i.status === "SENT" && i.dueDate && Date.parse(i.dueDate) < now)) && (Number(i.total) || 0) >= min)
      .map((i) => ({ invoiceNumber: i.invoiceNumber, status: i.status, total: Number(i.total) || 0, currency: i.currency, dueDate: i.dueDate, daysOverdue: i.dueDate ? Math.max(0, Math.floor((now - Date.parse(i.dueDate)) / DAY)) : null, contactName: name(bc.contactNameById, i.contactId), departmentName: name(bc.deptNameById, i.departmentId) }))
      .sort((a, b) => b.total - a.total);
    return { invoices: cap(rows, cfg.limit), count: rows.length, totalOverdue: rows.reduce((a, r) => a + r.total, 0), over10k: rows.filter((r) => r.total >= 10000).length };
  },

  async inaya_support_tickets(cfg, ctx) {
    // Inaya's own Customer Support module (permission-scoped exactly like the agent console: queue/team visibility applies).
    const { listTickets } = await import("../support/tickets.js");
    const { getSettings } = await import("../support/settings.js");
    const settings = await getSettings(ctx.orgId);
    const limit = Math.min(Number(cfg.limit) || 50, 100);
    const r = await listTickets({ orgId: ctx.orgId, settings, membership: ctx.membership, email: ctx.email, view: cfg.view || "all_open", limit });
    if (r.error) throw Object.assign(new Error(r.error), { retryable: false, code: "PERMISSION_DENIED" });
    const tickets = r.tickets.map((t) => ({ id: t.id, number: t.number, subject: String(t.subject || "").slice(0, 200), status: String(t.status).toLowerCase(), priority: String(t.priority).toLowerCase(), createdAt: t.createdAt, slaState: t.sla?.state || null, slaBreached: t.sla?.state === "BREACHED", slaAtRisk: t.sla?.state === "AT_RISK", assigned: !!t.assigneeEmail, channel: t.channel, source: "inaya-support" }));
    return { tickets, count: r.total, openCount: r.total, urgentCount: tickets.filter((t) => ["urgent", "high"].includes(t.priority)).length, slaBreachedCount: tickets.filter((t) => t.slaBreached).length, slaAtRiskCount: tickets.filter((t) => t.slaAtRisk).length, unassignedCount: tickets.filter((t) => !t.assigned).length, source: "Inaya Customer Support" };
  },

  async employee_tasks(cfg, { bc }) {
    const now = Date.now();
    const all = bc.scope.visibleTasks.map((t) => ({ title: t.title, status: t.status, priority: t.priority || null, dueDate: t.dueDate || null, assigneeEmail: t.assigneeEmail || null, projectName: name(bc.projNameById, t.projectId), overdue: !!(t.dueDate && Date.parse(t.dueDate) < now && !["DONE", "CANCELLED"].includes(t.status)) }));
    const open = all.filter((t) => !["DONE", "CANCELLED"].includes(t.status));
    const rows = cfg.onlyOverdue ? open.filter((t) => t.overdue) : open;
    const byStatus = {};
    for (const t of all) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    return { tasks: cap(rows, cfg.limit), count: rows.length, openCount: open.length, overdueCount: open.filter((t) => t.overdue).length, blockedCount: open.filter((t) => t.status === "BLOCKED").length, byStatus };
  },

  async procurement(cfg, { bc }) {
    const s = bc.scope;
    const po = s.visiblePurchaseOrders.map((p) => ({ status: p.status, supplierName: name(bc.supplierNameById, p.supplierId), itemCount: (p.items || []).length, departmentName: name(bc.deptNameById, p.departmentId), createdAt: p.createdAt }));
    const pr = s.visiblePurchaseRequests.map((p) => ({ status: p.status, estimatedCost: Number(p.estimatedCost) || 0, createdAt: p.createdAt }));
    const byStatus = (list) => list.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {});
    return { purchaseOrders: cap(po, cfg.limit), purchaseRequests: cap(pr, cfg.limit), totals: { purchaseOrders: po.length, purchaseRequests: pr.length, suppliers: s.visibleSuppliers.length, poByStatus: byStatus(po), prByStatus: byStatus(pr) } };
  },

  async inventory(cfg, { orgId, membership, email, bc }) {
    const insights = await computeBusinessInsights({ orgId, membership, email, periodDays: 30 });
    return { lowStockProducts: insights.lowStockProducts, totals: { products: bc.scope.visibleProducts.length, warehouses: bc.scope.visibleWarehouses.length, lowStock: insights.lowStockProducts.length } };
  },

  async projects(cfg, { bc }) {
    const tasksByProject = {};
    for (const t of bc.scope.visibleTasks) { const k = String(t.projectId); tasksByProject[k] = tasksByProject[k] || { total: 0, done: 0, blocked: 0 }; tasksByProject[k].total++; if (t.status === "DONE") tasksByProject[k].done++; if (t.status === "BLOCKED") tasksByProject[k].blocked++; }
    const rows = bc.scope.visibleProjects.map((p) => ({ name: p.name, status: p.status || null, departmentName: name(bc.deptNameById, p.departmentId), tasks: tasksByProject[String(p._id)] || { total: 0, done: 0, blocked: 0 } }));
    return { projects: cap(rows, cfg.limit), count: rows.length };
  },

  async documents(cfg, { bc }) {
    const byStatus = {};
    for (const d of bc.scope.visibleDocuments) byStatus[d.status] = (byStatus[d.status] || 0) + 1;
    const pending = bc.scope.visibleDocuments.filter((d) => ["PENDING", "UNDER_REVIEW"].includes(d.status)).map((d) => ({ filename: d.filename, status: d.status, departmentName: name(bc.deptNameById, d.departmentId), createdAt: d.createdAt }));
    return { pending: cap(pending, cfg.limit), byStatus, total: bc.scope.visibleDocuments.length };
  },

  async security_events(cfg, { orgId }) {
    const { aiSecurityChecks, nasThreatEvents } = await getOrgCollections();
    const since = new Date(Date.now() - (Number(cfg.days) || 7) * DAY).toISOString();
    const oid = toObjectId(orgId);
    const [checks, threats] = await Promise.all([
      aiSecurityChecks.aggregate([{ $match: { orgId: oid, createdAt: { $gte: since }, decision: { $ne: "ALLOW" } } }, { $group: { _id: { decision: "$decision", category: "$category" }, count: { $sum: 1 } } }]).toArray(),
      nasThreatEvents.find({ orgId: oid, detectedAt: { $gte: since } }).sort({ detectedAt: -1 }).limit(50).toArray(),
    ]);
    return { aiSecurity: checks.map((c) => ({ decision: c._id.decision, category: c._id.category, count: c.count })), aiBlocked: checks.filter((c) => c._id.decision === "BLOCK").reduce((a, c) => a + c.count, 0), nasThreats: threats.map((t) => ({ classification: t.classification || t.kind || null, detectedAt: t.detectedAt, status: t.status || null })), nasThreatCount: threats.length, periodDays: Number(cfg.days) || 7 };
  },

  async backup_status(cfg, { orgId }) {
    const { nasBackupRuns, storageBackupJobs } = await getOrgCollections();
    const oid = toObjectId(orgId);
    const since = new Date(Date.now() - 30 * DAY).toISOString();
    const [nas, storage] = await Promise.all([
      nasBackupRuns.aggregate([{ $match: { orgId: oid, startedAt: { $gte: since } } }, { $group: { _id: "$status", count: { $sum: 1 } } }]).toArray(),
      storageBackupJobs.aggregate([{ $match: { orgId: oid } }, { $group: { _id: "$status", count: { $sum: 1 } } }]).toArray().catch(() => []),
    ]);
    const lastFail = await nasBackupRuns.find({ orgId: oid, status: { $in: ["FAILED", "DEGRADED"] } }).sort({ startedAt: -1 }).limit(1).toArray();
    const toMap = (rows) => Object.fromEntries(rows.map((r) => [r._id || "UNKNOWN", r.count]));
    const nasMap = toMap(nas);
    return { nasBackupRuns30d: nasMap, storageBackupJobs: toMap(storage), failedNasBackups30d: (nasMap.FAILED || 0) + (nasMap.DEGRADED || 0), lastFailure: lastFail[0] ? { at: lastFail[0].startedAt, status: lastFail[0].status } : null, source: "NAS backup runs + storage backup jobs" };
  },

  async trust_health(cfg, { orgId }) {
    const h = await computeTrustHealth2(orgId);
    return { overall: h.overall ?? h.overallStatus ?? h.status ?? null, score: h.score ?? null, dimensions: Object.fromEntries(Object.entries(h.dimensions || {}).map(([k, v]) => [k, { status: v?.status ?? v?.state ?? null, score: v?.score ?? null }])) };
  },

  async business_brief(cfg, { orgId, membership, email }) {
    const period = ["daily", "weekly", "monthly", "yearly"].includes(cfg.period) ? cfg.period : "weekly";
    const { orgs } = await getOrgCollections();
    const org = await orgs.findOne({ _id: toObjectId(orgId) });
    const brief = await generateBusinessBrief({ orgId, membership, email, period, orgName: org?.name, includeNarrative: false });
    if (brief.error) throw Object.assign(new Error(brief.error), { retryable: false });
    return brief;
  },

  async evidence_events(cfg, { orgId, membership }) {
    const events = await listBusinessEvents({ orgId, membership, subjectType: cfg.subjectType || undefined, status: cfg.status || undefined });
    return { events: cap(events.map((e) => ({ eventId: String(e._id), eventType: e.eventType, subjectType: e.subjectType, status: e.status, risk: e.riskLevel || e.risk || null, label: e.subjectSummary?.label || null, createdAt: e.createdAt })), cfg.limit || 50), count: events.length };
  },

  async twin_result(cfg, { orgId }) {
    const sims = await listDigitalTwinSimulations({ orgId, limit: Math.min(Number(cfg.limit) || 10, 50) });
    return { simulations: sims, count: sims.length };
  },
};

/** Runs one data node for the executing identity. Fails closed if the identity lacks the node's scope. */
export async function runDataNode(type, config, dataCtx) {
  const def = NODE_TYPES[type];
  const kind = type.replace(/^data\./, "");
  const reader = READERS[kind];
  if (!def || !reader) throw Object.assign(new Error(`No data reader for ${type}.`), { retryable: false });
  if (def.scope && !scopeHeld(dataCtx.membership, def.scope)) throw Object.assign(new Error(`The executing user does not hold the "${def.scope}" data scope required by this node.`), { retryable: false, code: "PERMISSION_DENIED" });
  const out = await reader(config || {}, dataCtx);
  return bounded(out, 400_000);
}

/** KPI snapshot (SOW §12): the existing insights layer + a provenance envelope. */
export async function buildKpiSnapshot(config, dataCtx, upstream = {}) {
  const periodDays = Number(config?.periodDays) || 30;
  const { orgId, membership, email } = dataCtx;
  const insights = await computeBusinessInsights({ orgId, membership, email, periodDays });
  const sources = ["business-insights"];
  const extra = {};
  const derive = (key, fn) => { try { const v = fn(); if (v !== undefined) { extra[key] = v; } } catch { /* an absent upstream node simply contributes nothing */ } };
  for (const [k, v] of Object.entries(upstream || {})) {
    if (v?.invoices && v.totalOverdue !== undefined) { derive("overdueInvoices", () => ({ count: v.count, total: v.totalOverdue, over10k: v.over10k })); sources.push(k); }
    if (v?.tasks && v.overdueCount !== undefined) { derive("taskBacklog", () => ({ open: v.openCount, overdue: v.overdueCount, blocked: v.blockedCount })); sources.push(k); }
    if (v?.totals?.openPipelineValue !== undefined) { derive("salesPipeline", () => ({ openDeals: v.totals.openDeals, openValue: v.totals.openPipelineValue, wonValue: v.totals.wonValue })); sources.push(k); }
    if (v?.tickets || v?.supportBacklog !== undefined) { derive("supportBacklog", () => ({ open: v.openCount ?? (Array.isArray(v.tickets) ? v.tickets.length : null), urgent: v.urgentCount ?? null })); sources.push(k); }
    if (v?.lowStockProducts) { derive("inventoryExceptions", () => ({ lowStock: v.lowStockProducts.length })); sources.push(k); }
    if (v?.totals?.purchaseOrders !== undefined) { derive("procurement", () => ({ purchaseOrders: v.totals.purchaseOrders, purchaseRequests: v.totals.purchaseRequests })); sources.push(k); }
    if (v?.dimensions) { derive("trustHealth", () => ({ overall: v.overall, score: v.score })); sources.push(k); }
    if (v?.aiBlocked !== undefined) { derive("securityHealth", () => ({ aiBlocked: v.aiBlocked, nasThreats: v.nasThreatCount })); sources.push(k); }
    if (v?.failedNasBackups30d !== undefined) { derive("storageIntegrity", () => ({ failedBackups30d: v.failedNasBackups30d })); sources.push(k); }
  }
  return {
    snapshot: {
      generatedAt: new Date().toISOString(),
      period: { days: periodDays, label: `last ${periodDays} days` },
      organizationId: String(orgId),
      permissionScope: { executingIdentity: dataCtx.email, role: dataCtx.membership?.role || null, canManageOrg: canManageOrg(dataCtx.membership) },
      sourceSystems: [...new Set(sources)],
      calculation: { engine: "business-insights.computeBusinessInsights", version: "1", notes: "Values are computed from records the executing identity is permitted to see." },
      kpis: insights.kpis, trends: insights.trends, comparison: insights.comparison, alerts: insights.alerts, pendingApprovals: insights.pendingApprovals,
      ...extra,
    },
  };
}
