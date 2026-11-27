// src/lib/analytics/datasets.js
//
// Power BI integration: the read-only datasets of the Inaya Analytics API v1 (SOW sections 6 and 7). Each dataset declares
// its source, the permission it needs, its department and branch filters, the date field used for windowed (incremental)
// extraction, and an explicit field list: nothing is exposed just because it exists in a table (SOW 8.3).
//
// Rules shared by every dataset:
//   * the company comes from the access token, never the request;
//   * members only see their departments (departmentIds) and branches (locationIds), as everywhere in Inaya; owners and
//     admins see the whole company;
//   * money is returned in the record's currency (decimal), with the currency code beside it; no exchange rates invented;
//   * every row has a stable `id`, so a refresh replaces rows instead of duplicating them; soft-deleted rows stay as
//     `isDeleted: true` so a refresh can drop them;
//   * reads go to a secondary where the cluster has one, with a bounded window (max 366 days) and page (max 5,000 rows).
//
// Sales definitions are those of Inaya's own Commerce reports (src/lib/commerce/reports.js), in integer minor units:
//   gross = net + discounts (excl. tax) · net = after discounts (excl. tax) · tax · total = net + tax.

import { getOrgCollections, toObjectId, canManageOrg, canAccessFinance, canAccessHR } from "../orgs.js";
import { memberLocations } from "../workforce/scope.js";
import { connectToDatabase } from "../mongodb.js";

export const API_VERSION = "1.0";
export const MAX_PAGE = 5000;
export const MAX_WINDOW_DAYS = 366;
const READ = { readPreference: "secondaryPreferred" };
const money = (minor) => (minor === null || minor === undefined || !Number.isFinite(Number(minor)) ? null : Math.round(Number(minor)) / 100);
const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const s = (v) => (v === null || v === undefined ? null : String(v));
const d = (v) => (v ? new Date(v).toISOString() : null);

// ------------------------------------------------------------------------------------------------ permissions
const isMgr = (m) => canManageOrg(m) || m?.hrRole === "manager" || m?.commerceRole === "manager";
const OPS_VIEW_ALL = ["manager", "dispatcher", "advisor", "storekeeper"];
export const PERMISSIONS = {
  any: { label: "Any connected member", test: () => true },
  finance: { label: "Finance access (owner, admin or a finance role)", test: (m) => canAccessFinance(m) },
  hr: { label: "HR access (owner, admin or an HR role)", test: (m) => canAccessHR(m) },
  workforce: { label: "Managers (owner, admin, HR manager or store manager)", test: (m) => isMgr(m) },
  commerce: { label: "Shop supervisors and managers, or finance access", test: (m) => canManageOrg(m) || ["manager", "supervisor"].includes(m?.commerceRole) || canAccessFinance(m) },
  operations: { label: "Manage Orders managers, dispatchers, advisors and storekeepers", test: (m) => canManageOrg(m) || OPS_VIEW_ALL.includes(m?.opsRole) },
};
const deptFilter = (m, field = "departmentId") => (canManageOrg(m) ? {} : { [field]: { $in: (m?.departmentIds || []).map((x) => toObjectId(String(x))) } });
const branchFilter = (m, field = "warehouseId") => { const ids = memberLocations(m); return ids ? { [field]: { $in: ids.map((x) => toObjectId(String(x))) } } : {}; };

// ------------------------------------------------------------------------------------------------ datasets
// field: [name, type, description]; type is one of text, number, money, integer, datetime, date, boolean, id.
const F = (name, type, description) => ({ name, type, description });
export const DATASETS = {
  branches: {
    title: "Branches", module: "Company", permission: "any", source: "warehouses", window: null,
    filter: (m) => branchFilter(m, "_id"),
    fields: [F("id", "id", "Branch ID"), F("name", "text", "Branch name"), F("city", "text", "City"), F("createdAt", "datetime", "Created")],
    map: (r) => ({ id: s(r._id), name: r.name || null, city: r.city || null, createdAt: d(r.createdAt) }),
  },
  sales_lines: {
    title: "Shop sales lines (point of sale)", module: "Sales", permission: "commerce", source: "sales_orders", window: "completedAt",
    filter: (m) => ({ channel: "POS", ...branchFilter(m) }), explode: (r) => (r.lines || []).map((l, i) => ({ r, l, i })),
    fields: [F("id", "id", "Sale ID and line number"), F("saleId", "id", "Sale ID"), F("saleNumber", "text", "Receipt number"), F("completedAt", "datetime", "When the sale was completed"),
      F("branchId", "id", "Branch"), F("registerId", "id", "Till"), F("cashierEmail", "text", "Cashier"), F("customerId", "id", "Customer (if given)"), F("productId", "id", "Product"),
      F("sku", "text", "SKU"), F("productName", "text", "Product name"), F("productType", "text", "Product type"), F("quantity", "number", "Units"), F("grossSales", "money", "Gross sales: net plus discounts, excluding tax"),
      F("discounts", "money", "Line and whole-sale discounts"), F("netSales", "money", "Net sales after discounts, excluding tax"), F("tax", "money", "Tax"), F("total", "money", "Net sales plus tax"),
      F("cost", "money", "Cost of goods at sale time (blank when unknown)"), F("currency", "text", "Currency"), F("isVoided", "boolean", "The sale was voided (exclude from totals)")],
    map: ({ r, l, i }) => { const disc = (l.lineDiscountMinor || 0) + (l.orderShareMinor || 0); const gift = l.productType === "GIFT_CARD";
      return { id: `${r._id}:${i}`, saleId: s(r._id), saleNumber: r.saleNumber || null, completedAt: d(r.completedAt), branchId: s(r.warehouseId), registerId: s(r.registerId), cashierEmail: r.cashierEmail || null, customerId: s(r.contactId),
        productId: s(l.productId), sku: l.sku || null, productName: l.name || null, productType: l.productType || null, quantity: num(l.quantity), grossSales: gift ? 0 : money((l.netMinor || 0) + disc), discounts: gift ? 0 : money(disc),
        netSales: gift ? 0 : money(l.netMinor), tax: gift ? 0 : money(l.taxMinor), total: money(gift ? l.grossMinor : (l.netMinor || 0) + (l.taxMinor || 0)), cost: l.unitCost === null || l.unitCost === undefined ? null : Math.round(l.unitCost * 100 * (l.quantity || 0)) / 100,
        currency: r.currency || null, isVoided: r.status === "VOIDED" }; },
  },
  sales_refunds: {
    title: "Shop refunds (point of sale)", module: "Sales", permission: "commerce", source: "sales_orders", window: "refunds.createdAt",
    filter: (m) => ({ channel: "POS", ...branchFilter(m, "refunds.warehouseId") }),
    explode: (r, win, m) => { const ids = memberLocations(m); return (r.refunds || []).filter((x) => (!win || (x.createdAt >= win.from && x.createdAt < win.to)) && (!ids || ids.includes(String(x.warehouseId)))).flatMap((x) => (x.lines || []).map((l, i) => ({ r, x, l, i }))); },
    fields: [F("id", "id", "Refund number and line"), F("saleId", "id", "Original sale"), F("refundNumber", "text", "Refund number"), F("refundedAt", "datetime", "When refunded"), F("branchId", "id", "Branch"),
      F("processedBy", "text", "Who processed it"), F("productId", "id", "Product"), F("sku", "text", "SKU"), F("productName", "text", "Product"), F("quantity", "number", "Units returned"),
      F("netRefund", "money", "Refund excluding tax"), F("tax", "money", "Tax refunded"), F("total", "money", "Total refunded"), F("disposition", "text", "Restocked, quarantined or written off"), F("reason", "text", "Reason"), F("currency", "text", "Currency")],
    map: ({ r, x, l, i }) => ({ id: `${x.refundNumber}:${i}`, saleId: s(r._id), refundNumber: x.refundNumber || null, refundedAt: d(x.createdAt), branchId: s(x.warehouseId), processedBy: x.processedBy || null, productId: s(l.productId),
      sku: l.sku || null, productName: l.name || null, quantity: num(l.quantity), netRefund: money(l.netMinor), tax: money(l.taxMinor), total: money(l.grossMinor), disposition: l.disposition || null, reason: x.reason || null, currency: r.currency || null }),
  },
  sales_orders: {
    title: "Sales orders (online and office)", module: "Sales", permission: "commerce", source: "sales_orders", window: "createdAt", incremental: "updatedAt",
    filter: (m) => ({ channel: { $ne: "POS" }, ...deptFilter(m), ...branchFilter(m) }),
    fields: [F("id", "id", "Order ID"), F("orderNumber", "text", "Order number"), F("channel", "text", "Channel (office, online store, Shopify, WooCommerce)"), F("status", "text", "Status"), F("stage", "text", "Stage"),
      F("customerId", "id", "Customer"), F("branchId", "id", "Branch / warehouse"), F("orderDate", "date", "Order date"), F("subtotal", "money", "Subtotal"), F("tax", "money", "Tax"), F("total", "money", "Total"),
      F("currency", "text", "Currency"), F("fulfilmentMethod", "text", "Fulfilment"), F("invoiceId", "id", "Invoice"), F("createdAt", "datetime", "Created"), F("updatedAt", "datetime", "Last changed"), F("isDeleted", "boolean", "Deleted in Inaya")],
    map: (r) => ({ id: s(r._id), orderNumber: r.orderNumber || r.saleNumber || null, channel: r.channel || "OFFICE", status: r.status || null, stage: r.stage || null, customerId: s(r.contactId), branchId: s(r.warehouseId), orderDate: d(r.orderDate || r.createdAt),
      subtotal: num(r.subtotal), tax: num(r.tax), total: num(r.total), currency: r.currency || null, fulfilmentMethod: r.fulfilmentMethod || null, invoiceId: s(r.invoiceId), createdAt: d(r.createdAt), updatedAt: d(r.updatedAt), isDeleted: !!r.deletedAt }),
  },
  invoices: {
    title: "Invoices", module: "Finance", permission: "finance", source: "invoices", window: "createdAt", incremental: "updatedAt",
    filter: (m) => deptFilter(m),
    fields: [F("id", "id", "Invoice ID"), F("invoiceNumber", "text", "Invoice number"), F("customerId", "id", "Customer"), F("status", "text", "Status"), F("issueDate", "date", "Issue date"), F("dueDate", "date", "Due date"),
      F("total", "money", "Total"), F("currency", "text", "Currency"), F("departmentId", "id", "Department"), F("createdAt", "datetime", "Created"), F("updatedAt", "datetime", "Last changed"), F("isDeleted", "boolean", "Deleted in Inaya")],
    map: (r) => ({ id: s(r._id), invoiceNumber: r.invoiceNumber || null, customerId: s(r.contactId), status: r.status || null, issueDate: d(r.issueDate), dueDate: d(r.dueDate), total: num(r.total), currency: r.currency || null,
      departmentId: s(r.departmentId), createdAt: d(r.createdAt), updatedAt: d(r.updatedAt), isDeleted: !!r.deletedAt }),
  },
  payments: {
    title: "Payments", module: "Finance", permission: "finance", source: "payments", window: "createdAt", incremental: "updatedAt",
    filter: (m) => deptFilter(m),
    fields: [F("id", "id", "Payment ID"), F("paymentDate", "date", "Payment date"), F("direction", "text", "IN (received) or OUT (paid)"), F("amount", "money", "Amount"), F("currency", "text", "Currency"), F("method", "text", "Method"),
      F("status", "text", "Status"), F("invoiceId", "id", "Invoice paid"), F("expenseId", "id", "Expense paid"), F("purchaseOrderId", "id", "Purchase order paid"), F("departmentId", "id", "Department"), F("createdAt", "datetime", "Created"), F("isDeleted", "boolean", "Deleted in Inaya")],
    map: (r) => ({ id: s(r._id), paymentDate: d(r.paymentDate || r.createdAt), direction: r.direction || (r.relatedInvoiceId ? "IN" : r.relatedExpenseId || r.relatedPurchaseOrderId ? "OUT" : null), amount: num(r.amount), currency: r.currency || null,
      method: r.method || null, status: r.status || null, invoiceId: s(r.relatedInvoiceId), expenseId: s(r.relatedExpenseId), purchaseOrderId: s(r.relatedPurchaseOrderId), departmentId: s(r.departmentId), createdAt: d(r.createdAt), isDeleted: !!r.deletedAt }),
  },
  expenses: {
    title: "Expenses", module: "Finance", permission: "finance", source: "expenses", window: "createdAt", incremental: "updatedAt",
    filter: (m) => deptFilter(m),
    fields: [F("id", "id", "Expense ID"), F("expenseDate", "date", "Expense date"), F("vendor", "text", "Vendor"), F("category", "text", "Category"), F("description", "text", "Description"), F("amount", "money", "Amount"),
      F("currency", "text", "Currency"), F("status", "text", "Status"), F("departmentId", "id", "Department"), F("createdAt", "datetime", "Created"), F("updatedAt", "datetime", "Last changed"), F("isDeleted", "boolean", "Deleted in Inaya")],
    map: (r) => ({ id: s(r._id), expenseDate: d(r.expenseDate || r.createdAt), vendor: r.vendor || null, category: r.category || null, description: r.description ? String(r.description).slice(0, 300) : null, amount: num(r.amount),
      currency: r.currency || null, status: r.status || null, departmentId: s(r.departmentId), createdAt: d(r.createdAt), updatedAt: d(r.updatedAt), isDeleted: !!r.deletedAt }),
  },
  products: {
    title: "Products", module: "Inventory", permission: "any", source: "products", window: null,
    filter: (m) => deptFilter(m),
    fields: [F("id", "id", "Product ID"), F("sku", "text", "SKU"), F("name", "text", "Name"), F("category", "text", "Category"), F("productType", "text", "Type"), F("unit", "text", "Unit"), F("status", "text", "Status"),
      F("unitPrice", "money", "Selling price"), F("averageCost", "money", "Average cost"), F("reorderAt", "number", "Reorder level"), F("createdAt", "datetime", "Created"), F("isDeleted", "boolean", "Deleted in Inaya")],
    map: (r, m) => ({ id: s(r._id), sku: r.sku || null, name: r.name || null, category: r.category || "Uncategorised", productType: r.productType || null, unit: r.unit || null, status: r.status || null, unitPrice: num(r.unitPrice),
      averageCost: PERMISSIONS.commerce.test(m) ? num(r.avgCost ?? r.costPrice) : null, reorderAt: num(r.reorderAt), createdAt: d(r.createdAt), isDeleted: !!r.deletedAt }),
  },
  stock_balances: {
    title: "Stock on hand", module: "Inventory", permission: "any", source: "stock_levels", window: null,
    filter: (m) => branchFilter(m),
    fields: [F("id", "id", "Product and branch"), F("productId", "id", "Product"), F("branchId", "id", "Branch / warehouse"), F("quantity", "number", "Units on hand now")],
    map: (r) => ({ id: s(r._id), productId: s(r.productId), branchId: s(r.warehouseId), quantity: num(r.quantity) }),
  },
  stock_movements: {
    title: "Stock movements", module: "Inventory", permission: "any", source: "stock_movements", window: "createdAt",
    filter: (m) => branchFilter(m),
    fields: [F("id", "id", "Movement ID"), F("at", "datetime", "When"), F("productId", "id", "Product"), F("branchId", "id", "Branch / warehouse"), F("type", "text", "Movement type (sale, receipt, transfer, count, adjustment...)"),
      F("quantityChange", "number", "Units added (+) or removed (-)"), F("balanceAfter", "number", "Units on hand after"), F("unitCost", "money", "Unit cost"), F("purchaseOrderId", "id", "Purchase order"), F("saleId", "id", "Sale")],
    map: (r) => ({ id: s(r._id), at: d(r.createdAt), productId: s(r.productId), branchId: s(r.warehouseId), type: r.type || null, quantityChange: num(r.delta), balanceAfter: num(r.balanceAfter), unitCost: num(r.unitCost),
      purchaseOrderId: s(r.relatedPurchaseOrderId), saleId: s(r.relatedSaleId) }),
  },
  purchase_order_lines: {
    title: "Purchase order lines", module: "Purchasing", permission: "any", source: "purchase_orders", window: "createdAt", incremental: "updatedAt",
    filter: (m) => ({ ...deptFilter(m), ...branchFilter(m) }), explode: (r) => (r.lines || []).map((l, i) => ({ r, l, i })),
    fields: [F("id", "id", "Purchase order and line"), F("purchaseOrderId", "id", "Purchase order"), F("poNumber", "text", "PO number"), F("supplierId", "id", "Supplier"), F("branchId", "id", "Receiving branch"), F("status", "text", "Status"),
      F("productId", "id", "Product"), F("sku", "text", "SKU"), F("quantityOrdered", "number", "Ordered"), F("quantityReceived", "number", "Received"), F("unitPrice", "money", "Unit price"), F("lineTotal", "money", "Ordered x price"),
      F("currency", "text", "Currency"), F("createdAt", "datetime", "Created"), F("updatedAt", "datetime", "Last changed"), F("isDeleted", "boolean", "Deleted in Inaya")],
    map: ({ r, l, i }) => ({ id: `${r._id}:${i}`, purchaseOrderId: s(r._id), poNumber: r.poNumber || r.number || null, supplierId: s(r.supplierId), branchId: s(r.warehouseId), status: r.status || null, productId: s(l.productId), sku: l.sku || null,
      quantityOrdered: num(l.quantity), quantityReceived: num(l.receivedQuantity) ?? 0, unitPrice: num(l.unitPrice), lineTotal: Math.round((Number(l.quantity) || 0) * (Number(l.unitPrice) || 0) * 100) / 100, currency: r.currency || null,
      createdAt: d(r.createdAt), updatedAt: d(r.updatedAt), isDeleted: !!r.deletedAt }),
  },
  suppliers: {
    title: "Suppliers", module: "Purchasing", permission: "any", source: "suppliers", window: null,
    filter: (m) => deptFilter(m),
    fields: [F("id", "id", "Supplier ID"), F("name", "text", "Name"), F("email", "text", "Email"), F("phone", "text", "Phone"), F("createdAt", "datetime", "Created"), F("isDeleted", "boolean", "Deleted in Inaya")],
    map: (r) => ({ id: s(r._id), name: r.name || null, email: r.email || null, phone: r.phone || null, createdAt: d(r.createdAt), isDeleted: !!r.deletedAt }),
  },
  customers: {
    title: "Customers", module: "CRM", permission: "any", source: "crm_contacts", window: null,
    filter: (m) => deptFilter(m),
    fields: [F("id", "id", "Customer ID"), F("name", "text", "Name"), F("company", "text", "Company"), F("type", "text", "Type (customer, lead...)"), F("email", "text", "Email"), F("phone", "text", "Phone"), F("createdAt", "datetime", "Created"), F("isDeleted", "boolean", "Deleted in Inaya")],
    map: (r) => ({ id: s(r._id), name: r.name || null, company: r.company || null, type: r.type || null, email: r.email || null, phone: r.phone || null, createdAt: d(r.createdAt), isDeleted: !!r.deletedAt }),
  },
  work_orders: {
    title: "Work and repair orders", module: "Operations", permission: "operations", source: "calendar_records", window: "createdAt", incremental: "updatedAt",
    filter: (m) => ({ kind: "ops_job", ...branchFilter(m) }),
    fields: [F("id", "id", "Job ID"), F("number", "text", "WO / RO number"), F("type", "text", "WO (work order) or RO (repair order)"), F("status", "text", "Status"), F("priority", "text", "Priority"), F("category", "text", "Category"),
      F("branchId", "id", "Branch"), F("customerId", "id", "Customer"), F("managerEmail", "text", "Manager"), F("assignees", "text", "Assigned technicians (comma separated)"), F("plannedStart", "datetime", "Planned start"), F("dueAt", "datetime", "Due"),
      F("createdAt", "datetime", "Created"), F("completedAt", "datetime", "Completed (first time it reached a done state)"), F("turnaroundHours", "number", "Created to completed, hours"), F("estimatedCost", "money", "Estimated cost"), F("updatedAt", "datetime", "Last changed"), F("isArchived", "boolean", "Archived")],
    map: (r) => { const done = (r.history || []).find((h) => ["COMPLETED", "CLOSED", "DELIVERED"].includes(h.to)); const completedAt = done?.at || null;
      return { id: s(r._id), number: r.number || null, type: r.type || null, status: r.status || null, priority: r.priority || null, category: r.category || null, branchId: s(r.warehouseId), customerId: s(r.contactId), managerEmail: r.managerEmail || null,
        assignees: (r.assigneeEmails || []).join(", ") || null, plannedStart: d(r.plannedStart), dueAt: d(r.dueAt), createdAt: d(r.createdAt), completedAt: d(completedAt),
        turnaroundHours: completedAt ? Math.round(((new Date(completedAt) - new Date(r.createdAt)) / 3600000) * 10) / 10 : null, estimatedCost: num(r.estCost), updatedAt: d(r.updatedAt), isArchived: !!r.archived }; },
  },
  employees: {
    title: "Employees", module: "HR", permission: "hr", source: "employees", window: null,
    filter: (m) => ({ ...deptFilter(m), deletedAt: null }),
    fields: [F("id", "id", "Employee ID"), F("name", "text", "Name"), F("email", "text", "Work email"), F("departmentId", "id", "Department"), F("jobTitle", "text", "Job title"), F("createdAt", "datetime", "Created")],
    map: (r) => ({ id: s(r._id), name: r.fullName || r.name || null, email: r.memberEmail || r.email || null, departmentId: s(r.departmentId), jobTitle: r.jobTitle || r.title || null, createdAt: d(r.createdAt) }),
  },
  leave: {
    title: "Leave", module: "HR", permission: "hr", source: "leave_requests", window: "createdAt", incremental: "updatedAt",
    filter: () => ({ deletedAt: null }), employeeScoped: true,
    fields: [F("id", "id", "Leave request ID"), F("employeeId", "id", "Employee"), F("leaveType", "text", "Leave type"), F("startDate", "date", "From"), F("endDate", "date", "To"), F("days", "number", "Calendar days"), F("status", "text", "Status"), F("createdAt", "datetime", "Requested"), F("updatedAt", "datetime", "Last changed")],
    map: (r) => ({ id: s(r._id), employeeId: s(r.employeeId), leaveType: r.leaveType || null, startDate: d(r.startDate), endDate: d(r.endDate),
      days: r.startDate && r.endDate ? Math.max(1, Math.round((new Date(r.endDate) - new Date(r.startDate)) / 86400000) + 1) : null, status: r.status || null, createdAt: d(r.createdAt), updatedAt: d(r.updatedAt) }),
  },
  workforce_hours: {
    title: "Hours worked per person per day", module: "HR", permission: "workforce", source: "computed", window: "at", computed: true,
    fields: [F("id", "id", "Person and day"), F("email", "text", "Staff member"), F("date", "date", "Day"), F("workedHours", "number", "Hours worked (breaks excluded)"), F("breakHours", "number", "Break hours"), F("late", "boolean", "Arrived late for a scheduled shift"), F("lateMinutes", "number", "Minutes late"), F("leftEarly", "boolean", "Left before the shift ended")],
  },
};
export const DATASET_NAMES = Object.keys(DATASETS);

/** The catalogue and data dictionary (SOW 6.1, 13), filtered to what this person may read. */
export function catalogue(membership) {
  return DATASET_NAMES.map((name) => { const ds = DATASETS[name]; const allowed = PERMISSIONS[ds.permission].test(membership);
    return { name, title: ds.title, module: ds.module, allowed, permission: PERMISSIONS[ds.permission].label, incremental: !!ds.window, windowField: ds.window, fields: ds.fields }; });
}

// ------------------------------------------------------------------------------------------------ query
export class DatasetError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new DatasetError(status, message); };
const encCursor = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const decCursor = (c) => { try { const o = JSON.parse(Buffer.from(String(c), "base64url").toString()); return o && typeof o === "object" ? o : null; } catch { return null; } };

/** Pure: a validated window. from/to are dates or ISO times; default the last 30 days; at most MAX_WINDOW_DAYS. */
export function parseWindow({ from, to }, now = Date.now()) {
  const t = to ? new Date(to) : new Date(now); const f = from ? new Date(from) : new Date(t.getTime() - 30 * 86400000);
  if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) fail(400, "from and to must be dates, for example 2026-01-31.");
  if (f >= t) fail(400, "from must be before to.");
  if (t - f > MAX_WINDOW_DAYS * 86400000) fail(400, `A request can cover at most ${MAX_WINDOW_DAYS} days. Power BI's incremental refresh asks for smaller ranges automatically.`);
  return { from: f.toISOString(), to: t.toISOString() };
}

/** Reads one page of a dataset. Returns { dataset, rows, next, window, rowCount }. */
export async function readDataset({ orgId, membership, name, query = {} }) {
  const ds = DATASETS[name]; if (!ds) fail(404, "Unknown dataset.");
  if (!PERMISSIONS[ds.permission].test(membership)) fail(403, `This dataset needs: ${PERMISSIONS[ds.permission].label}.`);
  const limit = Math.min(Math.max(1, Number(query.limit) || 1000), MAX_PAGE);
  const win = ds.window ? parseWindow(query) : null;
  if (ds.computed) return computedHours({ orgId, membership, win, limit, cursor: query.cursor });
  const { db } = await connectToDatabase(); const col = db.collection(ds.source); const org = toObjectId(orgId);
  const cur = query.cursor ? decCursor(query.cursor) : null; if (query.cursor && !cur) fail(400, "The cursor is not valid.");
  const sortField = ds.window && ds.window !== "refunds.createdAt" ? ds.window : "_id";
  const q = { orgId: org, ...ds.filter(membership), ...(win ? { [ds.window]: { $gte: win.from, $lt: win.to } } : {}) };
  if (ds.employeeScoped && !canManageOrg(membership)) {
    const { employees } = await getOrgCollections();
    const ids = (await employees.find({ orgId: org, ...deptFilter(membership) }, { projection: { _id: 1 }, ...READ }).toArray()).map((e) => e._id); q.employeeId = { $in: ids };
  }
  if (cur) q.$or = sortField === "_id" ? [{ _id: { $gt: toObjectId(cur.id) } }] : [{ [sortField]: { $gt: cur.v } }, { [sortField]: cur.v, _id: { $gt: toObjectId(cur.id) } }];
  const docs = await col.find(q, READ).sort(sortField === "_id" ? { _id: 1 } : { [sortField]: 1, _id: 1 }).limit(limit + 1).toArray();
  const more = docs.length > limit; const page = more ? docs.slice(0, limit) : docs;
  const rows = []; for (const r of page) { if (ds.explode) for (const x of ds.explode(r, win, membership)) rows.push(ds.map(x, membership)); else rows.push(ds.map(r, membership)); }
  const last = page[page.length - 1];
  return { dataset: name, apiVersion: API_VERSION, window: win, rowCount: rows.length, rows, next: more ? encCursor({ v: sortField === "_id" ? null : last[sortField], id: String(last._id) }) : null };
}

/** Hours per person per day from clock punches and shifts, exactly as Inaya's timesheets compute them. */
async function computedHours({ orgId, membership, win, limit, cursor }) {
  const { computeTimesheet, getTimeSettings } = await import("../workforce/time.js");
  const { db } = await connectToDatabase(); const c = db.collection("calendar_records"); const org = toObjectId(orgId);
  const scope = branchFilter(membership, "locationId"); const settings = await getTimeSettings(orgId);
  const punches = await c.find({ orgId: org, kind: "w_punch", at: { $gte: win.from, $lt: win.to }, ...scope }, READ).limit(50000).toArray();
  const shifts = await c.find({ orgId: org, kind: "w_shift", status: { $in: ["PUBLISHED", "ACKNOWLEDGED"] }, start: { $gte: win.from, $lt: win.to }, ...scope }, READ).limit(20000).toArray();
  const rows = [];
  for (const e of [...new Set(punches.map((p) => p.email))].sort()) {
    const ts = computeTimesheet(punches.filter((p) => p.email === e), shifts.filter((x) => x.email === e), settings);
    for (const dd of ts.days || []) rows.push({ id: `${e}:${dd.date}`, email: e, date: dd.date, workedHours: Math.round(((dd.workedMs || 0) / 3600000) * 100) / 100, breakHours: Math.round(((dd.breakMs || 0) / 3600000) * 100) / 100, late: !!dd.late, lateMinutes: dd.lateMinutes || 0, leftEarly: !!dd.leftEarly });
  }
  rows.sort((a, b) => (a.id < b.id ? -1 : 1));
  const start = cursor ? Math.max(0, rows.findIndex((r) => r.id > (decCursor(cursor)?.id || ""))) : 0;
  const page = rows.slice(start === -1 ? rows.length : start, (start === -1 ? rows.length : start) + limit);
  const more = (start === -1 ? rows.length : start) + limit < rows.length;
  return { dataset: "workforce_hours", apiVersion: API_VERSION, window: win, rowCount: page.length, rows: page, next: more ? encCursor({ id: page[page.length - 1].id }) : null };
}
