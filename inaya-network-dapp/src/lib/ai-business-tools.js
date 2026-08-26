// src/lib/ai-business-tools.js
//
// Tool implementations for the AI Business Assistant (POST /api/ai/business-chat).
//
// THE HARD RULE: the assistant must never reveal anything the requesting
// user couldn't already see through the normal UI. This file is where
// that's enforced — not in the prompt, not as an instruction the model is
// asked to follow. Every tool here operates over `scope`, the result of
// getAccessibleScope() (document-permissions.js) computed ONCE per chat
// request from the caller's real org membership — the exact same
// department/project/document visibility resolution every other route in
// this app already uses. A document the caller can't see was never in
// `scope.visibleDocuments` to begin with, so no filename/department/
// project lookup here can ever surface it, no matter what the model asks
// for. "Who has access to this document" goes one step further and
// re-checks MANAGE-level access at call time via requireDocumentAccess()
// (the same gate the Permissions panel's API route uses) — VIEW/EDIT
// visibility is not enough to see the full grant list, so the tool
// returns a permissionDenied result instead of the data when that's the
// case, and the assistant must relay that rather than paraphrase around it.
//
// If a prompt-injection attempt (in a filename, a chat message, anything)
// tries to get the model to ask for something outside `scope`, the lookup
// just returns "not found" — there is no path from "the model asked" to
// "the database returned it" that skips permission resolution.

import { Type } from "@google/genai";
import { getOrgCollections } from "./orgs.js";
import { getAccessibleScope, requireDocumentAccess } from "./document-permissions.js";
import { TASK_STATES } from "./task-workflow.js";
import { DEAL_STAGES } from "./deal-workflow.js";
import { PURCHASE_ORDER_STATES } from "./purchase-order-workflow.js";
import { isLowStock } from "./inventory.js";
import { INVOICE_STATES } from "./invoice-workflow.js";
import { EXPENSE_STATES } from "./expense-workflow.js";
import { EMPLOYMENT_STATES } from "./employee-workflow.js";
import { computeBusinessInsights } from "./business-insights.js";

const ALLOWED_STATUSES = ["DRAFT", "PENDING", "UNDER_REVIEW", "APPROVED", "REJECTED", "ARCHIVED"];

/** Computed once per chat request and threaded into every tool call. */
export async function buildBusinessContext({ orgId, membership, email }) {
  const scope = await getAccessibleScope({ orgId, membership, email });
  const deptNameById = new Map(scope.visibleDepartments.map((d) => [d._id.toString(), d.name]));
  const projNameById = new Map(scope.visibleProjects.map((p) => [p._id.toString(), p.name]));
  const projDeptById = new Map(scope.visibleProjects.map((p) => [p._id.toString(), p.departmentId.toString()]));
  const contactNameById = new Map(scope.visibleContacts.map((c) => [c._id.toString(), c.name]));
  const supplierNameById = new Map(scope.visibleSuppliers.map((s) => [s._id.toString(), s.name]));
  return { orgId, membership, email, scope, deptNameById, projNameById, projDeptById, contactNameById, supplierNameById };
}

function matchesName(actualName, wanted) {
  if (!wanted) return true;
  return (actualName || "").toLowerCase().includes(wanted.toLowerCase());
}

function docSummary(doc, ctx) {
  return {
    filename: doc.filename,
    status: doc.status,
    accessLevel: doc.accessLevel || "DEPARTMENT",
    departmentName: ctx.deptNameById.get(doc.departmentId.toString()) || "Unknown",
    projectName: ctx.projNameById.get(doc.projectId.toString()) || "Unknown",
    uploadedByEmail: doc.uploadedByEmail,
    createdAt: doc.createdAt,
  };
}

// ============================================================
// Tool implementations — every one reads only from ctx.scope (or, for
// get_document_access, re-verifies MANAGE at call time).
// ============================================================
function listDocuments(args, ctx) {
  const { status, departmentName, projectName, filenameContains, limit } = args || {};
  const wantedStatuses = Array.isArray(status) ? status.filter((s) => ALLOWED_STATUSES.includes(s)) : null;

  const results = ctx.scope.visibleDocuments
    .filter((doc) => {
      if (wantedStatuses && wantedStatuses.length && !wantedStatuses.includes(doc.status)) return false;
      if (!matchesName(ctx.deptNameById.get(doc.departmentId.toString()), departmentName)) return false;
      if (!matchesName(ctx.projNameById.get(doc.projectId.toString()), projectName)) return false;
      if (filenameContains && !doc.filename.toLowerCase().includes(filenameContains.toLowerCase())) return false;
      return true;
    })
    .slice(0, Math.min(Math.max(limit || 10, 1), 25))
    .map((doc) => docSummary(doc, ctx));

  return { count: results.length, documents: results };
}

function listDepartments(_args, ctx) {
  const projectCountByDept = new Map();
  const docCountByDept = new Map();
  for (const p of ctx.scope.visibleProjects) {
    const key = p.departmentId.toString();
    projectCountByDept.set(key, (projectCountByDept.get(key) || 0) + 1);
  }
  for (const d of ctx.scope.visibleDocuments) {
    const key = d.departmentId.toString();
    docCountByDept.set(key, (docCountByDept.get(key) || 0) + 1);
  }
  return {
    departments: ctx.scope.visibleDepartments.map((d) => ({
      name: d.name,
      projectCount: projectCountByDept.get(d._id.toString()) || 0,
      documentCount: docCountByDept.get(d._id.toString()) || 0,
    })),
  };
}

function listProjects(args, ctx) {
  const { departmentName, onlyWithPendingDocuments } = args || {};
  const pendingProjectIds = new Set(
    ctx.scope.visibleDocuments
      .filter((d) => d.status === "PENDING" || d.status === "UNDER_REVIEW")
      .map((d) => d.projectId.toString())
  );
  const docCountByProject = new Map();
  for (const d of ctx.scope.visibleDocuments) {
    const key = d.projectId.toString();
    docCountByProject.set(key, (docCountByProject.get(key) || 0) + 1);
  }

  const results = ctx.scope.visibleProjects
    .filter((p) => matchesName(ctx.deptNameById.get(p.departmentId.toString()), departmentName))
    .filter((p) => !onlyWithPendingDocuments || pendingProjectIds.has(p._id.toString()))
    .map((p) => ({
      name: p.name,
      departmentName: ctx.deptNameById.get(p.departmentId.toString()) || "Unknown",
      documentCount: docCountByProject.get(p._id.toString()) || 0,
      hasPendingDocuments: pendingProjectIds.has(p._id.toString()),
    }));

  return { count: results.length, projects: results };
}

function listTasks(args, ctx) {
  const { status, assigneeEmail, projectName, departmentName, overdueOnly, limit } = args || {};
  const wantedStatuses = Array.isArray(status) ? status.filter((s) => TASK_STATES.includes(s)) : null;
  const now = Date.now();
  const normalizedAssignee = assigneeEmail ? assigneeEmail.trim().toLowerCase() : null;

  const results = ctx.scope.visibleTasks
    .filter((t) => {
      if (wantedStatuses && wantedStatuses.length && !wantedStatuses.includes(t.status)) return false;
      if (normalizedAssignee && (t.assigneeEmail || "").toLowerCase() !== normalizedAssignee) return false;
      if (!matchesName(ctx.deptNameById.get(t.departmentId.toString()), departmentName)) return false;
      if (!matchesName(ctx.projNameById.get(t.projectId.toString()), projectName)) return false;
      if (overdueOnly && !(t.dueDate && new Date(t.dueDate).getTime() < now && !["DONE", "CANCELLED"].includes(t.status))) return false;
      return true;
    })
    .slice(0, Math.min(Math.max(limit || 10, 1), 25))
    .map((t) => ({
      title: t.title,
      status: t.status,
      priority: t.priority,
      assigneeEmail: t.assigneeEmail || null,
      dueDate: t.dueDate || null,
      departmentName: ctx.deptNameById.get(t.departmentId.toString()) || "Unknown",
      projectName: ctx.projNameById.get(t.projectId.toString()) || "Unknown",
      createdAt: t.createdAt,
    }));

  return { count: results.length, tasks: results };
}

function listContacts(args, ctx) {
  const { type, search, departmentName, limit } = args || {};
  const results = ctx.scope.visibleContacts
    .filter((c) => {
      if (type && c.type !== type) return false;
      if (!matchesName(ctx.deptNameById.get(c.departmentId.toString()), departmentName)) return false;
      if (search && !matchesName(c.name, search) && !matchesName(c.company, search) && !matchesName(c.email, search)) return false;
      return true;
    })
    .slice(0, Math.min(Math.max(limit || 10, 1), 25))
    .map((c) => ({
      name: c.name, type: c.type, email: c.email || null, company: c.company || null,
      departmentName: ctx.deptNameById.get(c.departmentId.toString()) || "Unknown", createdAt: c.createdAt,
    }));
  return { count: results.length, contacts: results };
}

function listDeals(args, ctx) {
  const { stage, contactName, departmentName, limit } = args || {};
  const wantedStages = Array.isArray(stage) ? stage.filter((s) => DEAL_STAGES.includes(s)) : null;
  const results = ctx.scope.visibleDeals
    .filter((d) => {
      if (wantedStages && wantedStages.length && !wantedStages.includes(d.status)) return false;
      if (!matchesName(ctx.deptNameById.get(d.departmentId.toString()), departmentName)) return false;
      if (contactName && !matchesName(ctx.contactNameById.get(d.contactId.toString()), contactName)) return false;
      return true;
    })
    .slice(0, Math.min(Math.max(limit || 10, 1), 25))
    .map((d) => ({
      title: d.title, stage: d.status, value: d.value ?? null,
      contactName: ctx.contactNameById.get(d.contactId.toString()) || "Unknown",
      departmentName: ctx.deptNameById.get(d.departmentId.toString()) || "Unknown",
      projectName: d.projectId ? ctx.projNameById.get(d.projectId.toString()) || "Unknown" : null,
      createdAt: d.createdAt, closedAt: d.closedAt || null,
    }));
  return { count: results.length, deals: results };
}

function listSuppliers(args, ctx) {
  const { search, departmentName, limit } = args || {};
  const results = ctx.scope.visibleSuppliers
    .filter((s) => {
      if (!matchesName(ctx.deptNameById.get(s.departmentId.toString()), departmentName)) return false;
      if (search && !matchesName(s.name, search)) return false;
      return true;
    })
    .slice(0, Math.min(Math.max(limit || 10, 1), 25))
    .map((s) => ({ name: s.name, status: s.status, contactEmail: s.contactEmail || null, departmentName: ctx.deptNameById.get(s.departmentId.toString()) || "Unknown" }));
  return { count: results.length, suppliers: results };
}

function listPurchaseOrders(args, ctx) {
  const { status, supplierName, departmentName, limit } = args || {};
  const wantedStatuses = Array.isArray(status) ? status.filter((s) => PURCHASE_ORDER_STATES.includes(s)) : null;
  const results = ctx.scope.visiblePurchaseOrders
    .filter((po) => {
      if (wantedStatuses && wantedStatuses.length && !wantedStatuses.includes(po.status)) return false;
      if (!matchesName(ctx.deptNameById.get(po.departmentId.toString()), departmentName)) return false;
      if (supplierName && !matchesName(ctx.supplierNameById.get(po.supplierId.toString()), supplierName)) return false;
      return true;
    })
    .slice(0, Math.min(Math.max(limit || 10, 1), 25))
    .map((po) => ({
      status: po.status, supplierName: ctx.supplierNameById.get(po.supplierId.toString()) || "Unknown",
      itemCount: po.items.length, departmentName: ctx.deptNameById.get(po.departmentId.toString()) || "Unknown", createdAt: po.createdAt,
    }));
  return { count: results.length, purchaseOrders: results };
}

async function listProducts(args, ctx) {
  const { search, lowStockOnly, departmentName, limit } = args || {};
  let candidates = ctx.scope.visibleProducts.filter((p) => {
    if (!matchesName(ctx.deptNameById.get(p.departmentId.toString()), departmentName)) return false;
    if (search && !matchesName(p.name, search) && !matchesName(p.sku, search)) return false;
    return true;
  });

  // Real stock totals, not guessed — same one-extra-query pattern
  // products/route.js's GET handler uses, so lowStockOnly reflects the
  // actual current cross-warehouse quantity, never just reorderThreshold
  // being set.
  let totalByProduct = new Map();
  if (candidates.length) {
    const { stockLevels } = await getOrgCollections();
    const productIds = candidates.map((p) => p._id);
    const levels = await stockLevels.find({ productId: { $in: productIds } }).toArray();
    for (const l of levels) {
      const key = l.productId.toString();
      totalByProduct.set(key, (totalByProduct.get(key) || 0) + l.quantity);
    }
  }

  if (lowStockOnly) {
    candidates = candidates.filter((p) => isLowStock(p, totalByProduct.get(p._id.toString()) || 0));
  }

  const results = candidates
    .slice(0, Math.min(Math.max(limit || 10, 1), 25))
    .map((p) => ({
      sku: p.sku, name: p.name, status: p.status, totalStock: totalByProduct.get(p._id.toString()) || 0,
      reorderThreshold: p.reorderThreshold || 0, departmentName: ctx.deptNameById.get(p.departmentId.toString()) || "Unknown",
    }));
  return { count: results.length, products: results };
}

function listInvoices(args, ctx) {
  const { status, departmentName, limit } = args || {};
  const wantedStatuses = Array.isArray(status) ? status.filter((s) => INVOICE_STATES.includes(s)) : null;
  const results = ctx.scope.visibleInvoices
    .filter((i) => {
      if (wantedStatuses && wantedStatuses.length && !wantedStatuses.includes(i.status)) return false;
      if (!matchesName(ctx.deptNameById.get(i.departmentId.toString()), departmentName)) return false;
      return true;
    })
    .slice(0, Math.min(Math.max(limit || 10, 1), 25))
    .map((i) => ({
      invoiceNumber: i.invoiceNumber, status: i.status, total: i.total, currency: i.currency, dueDate: i.dueDate,
      contactName: ctx.contactNameById.get(i.contactId.toString()) || "Unknown",
      departmentName: ctx.deptNameById.get(i.departmentId.toString()) || "Unknown",
    }));
  return { count: results.length, invoices: results };
}

function listExpenses(args, ctx) {
  const { status, category, departmentName, limit } = args || {};
  const wantedStatuses = Array.isArray(status) ? status.filter((s) => EXPENSE_STATES.includes(s)) : null;
  const results = ctx.scope.visibleExpenses
    .filter((e) => {
      if (wantedStatuses && wantedStatuses.length && !wantedStatuses.includes(e.status)) return false;
      if (category && !matchesName(e.category, category)) return false;
      if (!matchesName(ctx.deptNameById.get(e.departmentId.toString()), departmentName)) return false;
      return true;
    })
    .slice(0, Math.min(Math.max(limit || 10, 1), 25))
    .map((e) => ({
      vendor: e.vendor, category: e.category, amount: e.amount, currency: e.currency, status: e.status,
      expenseDate: e.expenseDate, departmentName: ctx.deptNameById.get(e.departmentId.toString()) || "Unknown",
    }));
  const totalAmount = results.reduce((sum, e) => sum + (e.amount || 0), 0);
  return { count: results.length, totalAmount, expenses: results };
}

function listEmployees(args, ctx) {
  const { departmentName, status, search, limit } = args || {};
  const wantedStatuses = Array.isArray(status) ? status.filter((s) => EMPLOYMENT_STATES.includes(s)) : null;
  const results = ctx.scope.visibleEmployees
    .filter((e) => {
      if (wantedStatuses && wantedStatuses.length && !wantedStatuses.includes(e.employmentStatus)) return false;
      if (!matchesName(ctx.deptNameById.get(e.departmentId.toString()), departmentName)) return false;
      if (search && !matchesName(e.fullName, search) && !matchesName(e.jobTitle, search)) return false;
      return true;
    })
    .slice(0, Math.min(Math.max(limit || 10, 1), 25))
    .map((e) => ({
      fullName: e.fullName, jobTitle: e.jobTitle || null, employmentStatus: e.employmentStatus,
      departmentName: ctx.deptNameById.get(e.departmentId.toString()) || "Unknown",
    }));
  return { count: results.length, employees: results };
}

/** Searches employee DOCUMENTS (contracts, IDs, certificates) by employee
 *  name — restricted to ctx.scope.visibleEmployees, the exact same HR-
 *  role-or-self boundary every other employee lookup here respects; an
 *  employee this caller can't see was never a candidate to search
 *  attachments for in the first place. */
async function findEmployeeDocument(args, ctx) {
  const employeeName = args?.employeeName;
  if (!employeeName) return { error: "employeeName is required." };

  const matches = ctx.scope.visibleEmployees.filter((e) => matchesName(e.fullName, employeeName));
  if (matches.length === 0) return { notFound: true, employeeName };
  if (matches.length > 1) return { ambiguous: true, matches: matches.slice(0, 5).map((e) => ({ fullName: e.fullName, jobTitle: e.jobTitle || null })) };

  const employee = matches[0];
  const { attachments } = await getOrgCollections();
  const docs = await attachments.find({ orgId: employee.orgId, relatedRecordType: "EMPLOYEE", relatedRecordId: employee._id, deletedAt: null }).sort({ createdAt: -1 }).toArray();
  if (docs.length === 0) return { found: false, employeeName: employee.fullName, message: "No documents on file for this employee." };

  return { found: true, employeeName: employee.fullName, documents: docs.map((d) => ({ filename: d.filename, uploadedAt: d.createdAt })) };
}

async function getActivity(args, ctx) {
  const { departmentName, projectName, sinceDays, limit } = args || {};
  const cutoff = Date.now() - Math.min(Math.max(sinceDays || 7, 1), 90) * 24 * 60 * 60 * 1000;

  const targetDocIds = ctx.scope.visibleDocuments
    .filter((doc) => matchesName(ctx.deptNameById.get(doc.departmentId.toString()), departmentName))
    .filter((doc) => matchesName(ctx.projNameById.get(doc.projectId.toString()), projectName))
    .map((doc) => doc._id);

  if (targetDocIds.length === 0) return { count: 0, activity: [] };

  const filenameById = new Map(ctx.scope.visibleDocuments.map((d) => [d._id.toString(), d.filename]));
  const { documentActivity } = await getOrgCollections();
  const events = await documentActivity
    .find({ documentId: { $in: targetDocIds } })
    .sort({ timestamp: -1 })
    .limit(Math.min(Math.max(limit || 15, 1), 30))
    .toArray();

  const recent = events.filter((e) => new Date(e.timestamp).getTime() >= cutoff);
  return {
    count: recent.length,
    activity: recent.map((e) => ({
      filename: filenameById.get(e.documentId.toString()) || "Unknown document",
      action: e.action,
      previousState: e.previousState,
      newState: e.newState,
      actorId: e.actorId,
      timestamp: e.timestamp,
    })),
  };
}

async function getDocumentAccess(args, ctx) {
  const { filename, departmentName, projectName } = args || {};
  if (!filename) return { error: "A filename is required." };

  const candidates = ctx.scope.visibleDocuments
    .filter((doc) => doc.filename.toLowerCase().includes(filename.toLowerCase()))
    .filter((doc) => matchesName(ctx.deptNameById.get(doc.departmentId.toString()), departmentName))
    .filter((doc) => matchesName(ctx.projNameById.get(doc.projectId.toString()), projectName));

  if (candidates.length === 0) {
    // Deliberately vague — this must read identically whether the document
    // doesn't exist or the caller simply can't see it. Confirming "it
    // exists but you can't see it" would itself leak information.
    return { notFound: true, filename };
  }
  if (candidates.length > 1) {
    return {
      ambiguous: true,
      matches: candidates.slice(0, 5).map((doc) => docSummary(doc, ctx)),
    };
  }

  const doc = candidates[0];
  const access = await requireDocumentAccess({
    orgId: ctx.orgId,
    documentId: doc._id,
    membership: ctx.membership,
    email: ctx.email,
    minLevel: "MANAGE",
  });
  if (access.error) {
    return { permissionDenied: true, filename: doc.filename };
  }

  const { documentPermissions } = await getOrgCollections();
  const grants = await documentPermissions.find({ orgId: doc.orgId, documentId: doc._id }).toArray();

  return {
    filename: doc.filename,
    owner: doc.uploadedByEmail,
    grants: grants.map((g) => ({ email: g.email, level: g.level })),
  };
}

/** Same permission scope as every other tool (getAccessibleScope(), via
 *  computeBusinessInsights()) — trends (daily arrays) are stripped before
 *  returning to the model since that's chart data, not something a
 *  language model needs to reason over token-by-token; KPIs, the
 *  period-over-period comparison, and alerts are what "explain our KPIs" /
 *  "how's the business trending" questions actually need. */
async function getBusinessInsights(args, ctx) {
  const insights = await computeBusinessInsights({ orgId: ctx.orgId, membership: ctx.membership, email: ctx.email, periodDays: args?.periodDays });
  const { trends, ...rest } = insights;
  return rest;
}

// ============================================================
// Gemini function-calling declarations + dispatcher
// ============================================================
export const BUSINESS_TOOL_DECLARATIONS = [
  {
    name: "list_documents",
    description: "List documents the caller can see, optionally filtered by status, department, project, or filename.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        status: { type: Type.ARRAY, items: { type: Type.STRING, enum: ALLOWED_STATUSES }, description: "Filter to these workflow statuses." },
        departmentName: { type: Type.STRING, description: "Filter to documents in a department whose name contains this text." },
        projectName: { type: Type.STRING, description: "Filter to documents in a project whose name contains this text." },
        filenameContains: { type: Type.STRING, description: "Filter to filenames containing this text." },
        limit: { type: Type.INTEGER, description: "Max results, default 10, max 25." },
      },
    },
  },
  {
    name: "list_departments",
    description: "List every department the caller can see, with project and document counts.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: "list_projects",
    description: "List projects the caller can see, optionally filtered to a department or to only projects with pending/under-review documents.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        departmentName: { type: Type.STRING, description: "Filter to a department whose name contains this text." },
        onlyWithPendingDocuments: { type: Type.BOOLEAN, description: "If true, only include projects that currently have a PENDING or UNDER_REVIEW document." },
      },
    },
  },
  {
    name: "list_tasks",
    description: "List tasks the caller can see, optionally filtered by status, assignee, project, department, or overdue-only.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        status: { type: Type.ARRAY, items: { type: Type.STRING, enum: TASK_STATES }, description: "Filter to these task statuses." },
        assigneeEmail: { type: Type.STRING, description: "Filter to tasks assigned to this exact email." },
        projectName: { type: Type.STRING, description: "Filter to a project whose name contains this text." },
        departmentName: { type: Type.STRING, description: "Filter to a department whose name contains this text." },
        overdueOnly: { type: Type.BOOLEAN, description: "If true, only include tasks past their due date that aren't done or cancelled." },
        limit: { type: Type.INTEGER, description: "Max results, default 10, max 25." },
      },
    },
  },
  {
    name: "list_contacts",
    description: "List CRM contacts (leads and customers) the caller can see, optionally filtered by type, a search term, or department.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        type: { type: Type.STRING, enum: ["LEAD", "CUSTOMER"], description: "Filter to only leads or only customers." },
        search: { type: Type.STRING, description: "Filter to contacts whose name, company, or email contains this text." },
        departmentName: { type: Type.STRING, description: "Filter to a department whose name contains this text." },
        limit: { type: Type.INTEGER, description: "Max results, default 10, max 25." },
      },
    },
  },
  {
    name: "list_deals",
    description: "List sales pipeline deals the caller can see, optionally filtered by stage, contact name, or department.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        stage: { type: Type.ARRAY, items: { type: Type.STRING, enum: DEAL_STAGES }, description: "Filter to these pipeline stages." },
        contactName: { type: Type.STRING, description: "Filter to deals for a contact whose name contains this text." },
        departmentName: { type: Type.STRING, description: "Filter to a department whose name contains this text." },
        limit: { type: Type.INTEGER, description: "Max results, default 10, max 25." },
      },
    },
  },
  {
    name: "list_suppliers",
    description: "List procurement suppliers the caller can see, optionally filtered by a search term or department.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        search: { type: Type.STRING, description: "Filter to suppliers whose name contains this text." },
        departmentName: { type: Type.STRING, description: "Filter to a department whose name contains this text." },
        limit: { type: Type.INTEGER, description: "Max results, default 10, max 25." },
      },
    },
  },
  {
    name: "list_purchase_orders",
    description: "List purchase orders the caller can see, optionally filtered by status, supplier name, or department — use this for questions like \"which POs are awaiting approval\".",
    parameters: {
      type: Type.OBJECT,
      properties: {
        status: { type: Type.ARRAY, items: { type: Type.STRING, enum: PURCHASE_ORDER_STATES }, description: "Filter to these PO statuses." },
        supplierName: { type: Type.STRING, description: "Filter to a supplier whose name contains this text." },
        departmentName: { type: Type.STRING, description: "Filter to a department whose name contains this text." },
        limit: { type: Type.INTEGER, description: "Max results, default 10, max 25." },
      },
    },
  },
  {
    name: "list_products",
    description: "List inventory products the caller can see, with real current stock totals, optionally filtered by a search term, department, or low-stock-only.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        search: { type: Type.STRING, description: "Filter to products whose name or SKU contains this text." },
        departmentName: { type: Type.STRING, description: "Filter to a department whose name contains this text." },
        lowStockOnly: { type: Type.BOOLEAN, description: "If true, only include products whose real current total stock is at or below their reorder threshold." },
        limit: { type: Type.INTEGER, description: "Max results, default 10, max 25." },
      },
    },
  },
  {
    name: "list_invoices",
    description: "List invoices the caller can see, optionally filtered by status or department — use this for questions like \"show outstanding invoices\".",
    parameters: {
      type: Type.OBJECT,
      properties: {
        status: { type: Type.ARRAY, items: { type: Type.STRING, enum: INVOICE_STATES }, description: "Filter to these invoice statuses." },
        departmentName: { type: Type.STRING, description: "Filter to a department whose name contains this text." },
        limit: { type: Type.INTEGER, description: "Max results, default 10, max 25." },
      },
    },
  },
  {
    name: "list_expenses",
    description: "List expenses the caller can see, optionally filtered by status, category, or department — use this for questions like \"summarize this month's expenses\" (also returns a real totalAmount for the filtered results).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        status: { type: Type.ARRAY, items: { type: Type.STRING, enum: EXPENSE_STATES }, description: "Filter to these expense statuses." },
        category: { type: Type.STRING, description: "Filter to a category whose name contains this text." },
        departmentName: { type: Type.STRING, description: "Filter to a department whose name contains this text." },
        limit: { type: Type.INTEGER, description: "Max results, default 10, max 25." },
      },
    },
  },
  {
    name: "list_employees",
    description: "List employees the caller can see, optionally filtered by department, employment status, or name/job-title search — use this for questions like \"how many employees are in Engineering\".",
    parameters: {
      type: Type.OBJECT,
      properties: {
        departmentName: { type: Type.STRING, description: "Filter to a department whose name contains this text." },
        status: { type: Type.ARRAY, items: { type: Type.STRING, enum: EMPLOYMENT_STATES }, description: "Filter to these employment statuses." },
        search: { type: Type.STRING, description: "Filter to employees whose name or job title contains this text." },
        limit: { type: Type.INTEGER, description: "Max results, default 10, max 25." },
      },
    },
  },
  {
    name: "find_employee_document",
    description: "Find HR documents on file for a specific employee by name (e.g. \"find the employment document for this employee\"). Only searches employees the caller can already see.",
    parameters: {
      type: Type.OBJECT,
      properties: { employeeName: { type: Type.STRING, description: "The employee's name, or a distinctive part of it." } },
      required: ["employeeName"],
    },
  },
  {
    name: "get_activity",
    description: "Get recent document activity (submissions, approvals, rejections, shares, etc.), optionally scoped to a department or project and a time window.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        departmentName: { type: Type.STRING, description: "Filter to a department whose name contains this text." },
        projectName: { type: Type.STRING, description: "Filter to a project whose name contains this text." },
        sinceDays: { type: Type.INTEGER, description: "How many days back to look, default 7, max 90." },
        limit: { type: Type.INTEGER, description: "Max results, default 15, max 30." },
      },
    },
  },
  {
    name: "get_document_access",
    description: "Get who has access to a specific document by filename (or partial filename). Only succeeds if the caller has MANAGE-level access to that document — otherwise returns permissionDenied.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        filename: { type: Type.STRING, description: "The document's filename, or a distinctive part of it." },
        departmentName: { type: Type.STRING, description: "Optional — narrow down if multiple documents share a similar name." },
        projectName: { type: Type.STRING, description: "Optional — narrow down if multiple documents share a similar name." },
      },
      required: ["filename"],
    },
  },
  {
    name: "get_business_insights",
    description: "Get KPI summary (revenue, expenses, pipeline, task completion, headcount, etc.), period-over-period comparison, and active business alerts (overdue invoices, low stock, overdue tasks, pending approvals, significant KPI swings). Use this for questions like \"how's the business doing\", \"explain our KPIs\", \"what changed this month\", or \"any alerts I should know about\".",
    parameters: {
      type: Type.OBJECT,
      properties: {
        periodDays: { type: Type.INTEGER, description: "Comparison window in days, default 30, max 365." },
      },
    },
  },
];

const TOOL_IMPLEMENTATIONS = {
  list_documents: listDocuments,
  list_departments: listDepartments,
  list_projects: listProjects,
  list_tasks: listTasks,
  list_contacts: listContacts,
  list_deals: listDeals,
  list_suppliers: listSuppliers,
  list_purchase_orders: listPurchaseOrders,
  list_products: listProducts,
  list_invoices: listInvoices,
  list_expenses: listExpenses,
  list_employees: listEmployees,
  find_employee_document: findEmployeeDocument,
  get_activity: getActivity,
  get_document_access: getDocumentAccess,
  get_business_insights: getBusinessInsights,
};

export async function runBusinessTool(name, args, ctx) {
  const impl = TOOL_IMPLEMENTATIONS[name];
  if (!impl) return { error: `Unknown tool: ${name}` };
  return impl(args, ctx);
}

export function businessSystemInstruction({ orgName, role, isManager }) {
  return `You are the Inaya AI Business Assistant, embedded in the "${orgName}" company's Business Workspace. The person you're talking to signed in as ${role}${isManager ? " (has manage/approval authority)" : " (standard member)"}.

You answer questions about this company's departments, projects, documents, workflow status, activity, tasks (status, priority, assignee, due dates), CRM (leads, customers, sales pipeline deals), procurement (suppliers, purchase orders and their approval status), inventory (products, real current stock levels, low-stock items), finance (invoices, expenses, their approval status and totals), and HR (employees, their department/status, and their documents) by calling the provided tools — never guess or invent data. Every tool is already scoped to exactly what this person is allowed to see (finance and HR data specifically respect Finance/HR role and department-manager/self-access boundaries) — if a tool returns notFound or an empty list, that's the honest answer (either it doesn't exist or they don't have access to it) — do not speculate about which.

Finance and HR data is sensitive — never volunteer another employee's personal HR details or another department's financial figures beyond what the tool itself returned; if list_employees or list_invoices/list_expenses comes back empty for a query, that means this person can't see that data (or it doesn't exist), not that you should guess at plausible-sounding figures.

If get_document_access returns permissionDenied, tell the user plainly that they don't have permission to view who has access to that document (only the document's owner, an explicit MANAGE grant, or a company owner/admin can see that) — do not attempt to answer the question any other way, and do not reveal the document's owner or any grant information in that case.

Keep answers concise and concrete: reference actual filenames, department/project names, statuses, and dates from the tool results. Use plain language, not raw JSON. If a request is ambiguous (e.g. multiple documents match a name), ask a short clarifying question or list the candidates the tool returned.

For "how's the business doing", KPI, trend, or alert questions, use get_business_insights rather than manually combining several list_* calls — it's the same permission-scoped aggregate the Business Insights dashboard itself shows.

You cannot take actions (approve, reject, upload, share, change permissions) — you only look things up and summarize. If asked to perform an action, explain that they should use the workspace UI for that.`;
}
