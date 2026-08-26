// src/lib/business-insights.js
//
// Inaya Business Insights & KPI Dashboard — computes KPIs, trends,
// period-over-period comparisons, and alerts from the SAME permission-
// scoped data every other Business Workspace surface already uses.
// getAccessibleScope() is called once; nothing here re-derives or
// bypasses that resolution, so a user's KPI cards, charts, and AI
// insights are exactly bounded by what they can already see everywhere
// else (department/finance-role/HR-role scoping included) — same
// guarantee ai-business-tools.js already documents for its own tools.
//
// No new collections, no new writes — this is a read-only aggregation
// layer over invoices/expenses/deals/tasks/products/employees/purchase
// orders/purchase requests/documents, all already tracked.

import { getAccessibleScope } from "./document-permissions.js";
import { isLowStock } from "./inventory.js";

const DEFAULT_PERIOD_DAYS = 30;
const MAX_PERIOD_DAYS = 365;
const SIGNIFICANT_CHANGE_PCT = 20; // a swing at/beyond this % is flagged as a "significant KPI change" alert

function clampPeriodDays(v) {
  const n = Number(v) || DEFAULT_PERIOD_DAYS;
  return Math.min(Math.max(Math.round(n), 1), MAX_PERIOD_DAYS);
}

function dayKey(iso) {
  return new Date(iso).toISOString().slice(0, 10); // YYYY-MM-DD
}

/** Fills in zero-value days so a chart doesn't have gaps where nothing happened. */
function buildDailySeries(rangeStartMs, rangeEndMs, records, dateField, valueField) {
  const byDay = new Map();
  for (const r of records) {
    const t = new Date(r[dateField]).getTime();
    if (Number.isNaN(t) || t < rangeStartMs || t > rangeEndMs) continue;
    const key = dayKey(r[dateField]);
    const value = valueField ? Number(r[valueField]) || 0 : 1;
    byDay.set(key, (byDay.get(key) || 0) + value);
  }
  const series = [];
  for (let t = rangeStartMs; t <= rangeEndMs; t += 24 * 60 * 60 * 1000) {
    const key = new Date(t).toISOString().slice(0, 10);
    series.push({ date: key, value: byDay.get(key) || 0 });
  }
  return series;
}

function sumInRange(records, dateField, valueField, startMs, endMs) {
  let total = 0;
  for (const r of records) {
    const t = new Date(r[dateField]).getTime();
    if (!Number.isNaN(t) && t >= startMs && t <= endMs) total += Number(r[valueField]) || 0;
  }
  return total;
}

function countInRange(records, dateField, startMs, endMs, predicate) {
  let count = 0;
  for (const r of records) {
    const t = new Date(r[dateField]).getTime();
    if (Number.isNaN(t) || t < startMs || t > endMs) continue;
    if (!predicate || predicate(r)) count++;
  }
  return count;
}

function pctChange(current, previous) {
  if (previous === 0) return current === 0 ? 0 : 100;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

export async function computeBusinessInsights({ orgId, membership, email, periodDays }) {
  const days = clampPeriodDays(periodDays);
  const scope = await getAccessibleScope({ orgId, membership, email });
  const {
    visibleTasks, visibleContacts, visibleDeals, visibleSuppliers,
    visiblePurchaseRequests, visiblePurchaseOrders, visibleProducts,
    visibleInvoices, visibleExpenses, visibleEmployees, visibleDocuments,
  } = scope;

  const now = Date.now();
  const periodStart = now - days * 24 * 60 * 60 * 1000;
  const prevPeriodStart = periodStart - days * 24 * 60 * 60 * 1000;
  const prevPeriodEnd = periodStart;

  // ============================================================
  // KPI cards — current snapshot, not period-filtered (a headcount or
  // open-pipeline-value is a "right now" number, not a "this period" sum).
  // ============================================================
  const paidInvoices = visibleInvoices.filter((i) => i.status === "PAID");
  const approvedExpenses = visibleExpenses.filter((e) => e.status === "APPROVED");
  const openDeals = visibleDeals.filter((d) => !["WON", "LOST"].includes(d.status));
  const wonDeals = visibleDeals.filter((d) => d.status === "WON");
  const openTasks = visibleTasks.filter((t) => !["DONE", "CANCELLED"].includes(t.status));
  const doneTasks = visibleTasks.filter((t) => t.status === "DONE");
  const overdueTasks = openTasks.filter((t) => t.dueDate && new Date(t.dueDate).getTime() < now);
  const overdueInvoices = visibleInvoices.filter((i) => i.status === "OVERDUE");
  const activeEmployees = visibleEmployees.filter((e) => e.employmentStatus === "ACTIVE");

  let totalStockByProduct = new Map();
  // Real stock totals only computed when needed by the caller (route/tool
  // both pass scope.visibleProducts through here) — matches list_products'
  // own "don't guess low-stock from reorderThreshold alone" discipline.
  const lowStockProducts = [];
  if (visibleProducts.length) {
    const { getOrgCollections } = await import("./orgs.js");
    const { stockLevels } = await getOrgCollections();
    const productIds = visibleProducts.map((p) => p._id);
    const levels = await stockLevels.find({ productId: { $in: productIds } }).toArray();
    for (const l of levels) {
      const key = l.productId.toString();
      totalStockByProduct.set(key, (totalStockByProduct.get(key) || 0) + l.quantity);
    }
    for (const p of visibleProducts) {
      const total = totalStockByProduct.get(p._id.toString()) || 0;
      if (isLowStock(p, total)) lowStockProducts.push({ sku: p.sku, name: p.name, totalStock: total, reorderThreshold: p.reorderThreshold || 0 });
    }
  }

  const pendingApprovals = {
    documents: visibleDocuments.filter((d) => d.status === "PENDING" || d.status === "UNDER_REVIEW").length,
    purchaseRequests: visiblePurchaseRequests.filter((r) => r.status === "PENDING_APPROVAL").length,
    purchaseOrders: visiblePurchaseOrders.filter((po) => po.status === "PENDING_APPROVAL").length,
    expenses: visibleExpenses.filter((e) => e.status === "PENDING_APPROVAL").length,
  };
  const totalPendingApprovals = pendingApprovals.documents + pendingApprovals.purchaseRequests + pendingApprovals.purchaseOrders + pendingApprovals.expenses;

  const kpis = {
    revenue: { value: paidInvoices.reduce((s, i) => s + (i.total || 0), 0), label: "Total Revenue (Paid Invoices)" },
    expenses: { value: approvedExpenses.reduce((s, e) => s + (e.amount || 0), 0), label: "Total Approved Expenses" },
    pipelineValue: { value: openDeals.reduce((s, d) => s + (d.value || 0), 0), label: "Open Pipeline Value" },
    winRate: { value: visibleDeals.length ? Math.round((wonDeals.length / visibleDeals.length) * 1000) / 10 : 0, label: "Deal Win Rate (%)" },
    taskCompletionRate: { value: visibleTasks.length ? Math.round((doneTasks.length / visibleTasks.length) * 1000) / 10 : 0, label: "Task Completion Rate (%)" },
    overdueTasks: { value: overdueTasks.length, label: "Overdue Tasks" },
    overdueInvoices: { value: overdueInvoices.length, label: "Overdue Invoices" },
    lowStockCount: { value: lowStockProducts.length, label: "Low-Stock Products" },
    headcount: { value: activeEmployees.length, label: "Active Employees" },
    pendingApprovals: { value: totalPendingApprovals, label: "Pending Approvals" },
    openContacts: { value: visibleContacts.length, label: "CRM Contacts" },
    activeSuppliers: { value: visibleSuppliers.filter((s) => s.status !== "INACTIVE").length, label: "Active Suppliers" },
  };

  // ============================================================
  // Trends — daily series over the selected period, for charts.
  // ============================================================
  const trends = {
    revenue: buildDailySeries(periodStart, now, paidInvoices, "updatedAt", "total"),
    expenses: buildDailySeries(periodStart, now, approvedExpenses, "updatedAt", "amount"),
    tasksCompleted: buildDailySeries(periodStart, now, doneTasks, "updatedAt", null),
    dealsWon: buildDailySeries(periodStart, now, wonDeals, "closedAt", "value"),
  };

  // ============================================================
  // Period-over-period comparison — same-length prior window.
  // ============================================================
  const comparison = {
    revenue: {
      current: sumInRange(paidInvoices, "updatedAt", "total", periodStart, now),
      previous: sumInRange(paidInvoices, "updatedAt", "total", prevPeriodStart, prevPeriodEnd),
    },
    expenses: {
      current: sumInRange(approvedExpenses, "updatedAt", "amount", periodStart, now),
      previous: sumInRange(approvedExpenses, "updatedAt", "amount", prevPeriodStart, prevPeriodEnd),
    },
    dealsWon: {
      current: countInRange(wonDeals, "closedAt", periodStart, now),
      previous: countInRange(wonDeals, "closedAt", prevPeriodStart, prevPeriodEnd),
    },
    tasksCompleted: {
      current: countInRange(doneTasks, "updatedAt", periodStart, now),
      previous: countInRange(doneTasks, "updatedAt", prevPeriodStart, prevPeriodEnd),
    },
  };
  for (const key of Object.keys(comparison)) {
    comparison[key].changePct = pctChange(comparison[key].current, comparison[key].previous);
  }

  // ============================================================
  // Alerts — actionable conditions, most-severe first.
  // ============================================================
  const alerts = [];
  if (overdueInvoices.length > 0) {
    alerts.push({ severity: "high", type: "OVERDUE_INVOICES", message: `${overdueInvoices.length} invoice${overdueInvoices.length === 1 ? "" : "s"} overdue.`, count: overdueInvoices.length, drillTo: "finance" });
  }
  if (lowStockProducts.length > 0) {
    alerts.push({ severity: "medium", type: "LOW_STOCK", message: `${lowStockProducts.length} product${lowStockProducts.length === 1 ? "" : "s"} at or below reorder threshold.`, count: lowStockProducts.length, drillTo: "inventory" });
  }
  if (overdueTasks.length > 0) {
    alerts.push({ severity: "medium", type: "OVERDUE_TASKS", message: `${overdueTasks.length} task${overdueTasks.length === 1 ? "" : "s"} overdue.`, count: overdueTasks.length, drillTo: "tasks" });
  }
  if (totalPendingApprovals > 0) {
    alerts.push({ severity: "low", type: "PENDING_APPROVALS", message: `${totalPendingApprovals} item${totalPendingApprovals === 1 ? "" : "s"} awaiting approval.`, count: totalPendingApprovals, drillTo: "approvals" });
  }
  for (const [key, c] of Object.entries(comparison)) {
    if (Math.abs(c.changePct) >= SIGNIFICANT_CHANGE_PCT && (c.current > 0 || c.previous > 0)) {
      const direction = c.changePct > 0 ? "up" : "down";
      alerts.push({ severity: c.changePct < 0 && (key === "revenue" || key === "dealsWon") ? "medium" : "low", type: "SIGNIFICANT_KPI_CHANGE", message: `${key} is ${direction} ${Math.abs(c.changePct)}% vs. the previous ${days}-day period.`, drillTo: key === "expenses" || key === "revenue" ? "finance" : "crm" });
    }
  }
  const severityRank = { high: 0, medium: 1, low: 2 };
  alerts.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);

  return {
    periodDays: days,
    generatedAt: new Date().toISOString(),
    kpis,
    trends,
    comparison,
    alerts,
    pendingApprovals,
    lowStockProducts: lowStockProducts.slice(0, 10),
    overdueInvoices: overdueInvoices.slice(0, 10).map((i) => ({ invoiceNumber: i.invoiceNumber, total: i.total, dueDate: i.dueDate })),
    overdueTasks: overdueTasks.slice(0, 10).map((t) => ({ title: t.title, dueDate: t.dueDate, assigneeEmail: t.assigneeEmail || null })),
  };
}
