// src/lib/orgSearch.js
//
// Enterprise OS SOW, Phase 4 — Unified Search (org scope). Confirmed
// before writing this: the only real search endpoint anywhere is
// /api/learn/search, a YouTube Data API proxy for the Learn video
// library — there is no cross-entity or internal search feature on
// either surface. This is the first one.
//
// Reuses getAccessibleScope() as its ONLY data source (document-
// permissions.js) — every array searched here is already permission-
// filtered by that function, so a result can never leak something the
// caller couldn't already see on that entity's own view. No new
// permission logic, no separate "is this visible" re-check.
//
// Each entity type has its own real display-name field (departments use
// `name`, documents use `filename`, deals use `title`, invoices use
// `invoiceNumber`, etc.) rather than one guessed field name applied
// everywhere — matchText() below tries a short, explicit list of the
// actual candidate fields per record and falls back safely (no match,
// not a crash) if a field this wasn't told about turns out to matter.

import { getAccessibleScope } from "./document-permissions.js";

const SEARCHABLE_FIELDS = ["name", "title", "filename", "invoiceNumber", "description", "email", "company"];

function matchText(record, query) {
  const q = query.toLowerCase();
  for (const field of SEARCHABLE_FIELDS) {
    const value = record?.[field];
    if (typeof value === "string" && value.toLowerCase().includes(q)) return value;
  }
  return null;
}

// {entityType, arrayKey (from getAccessibleScope), title field for the
// result label if matchText finds a hit on a different field, view to
// navigate to (Workspace's existing NAV_ITEMS keys)}
const ENTITY_SOURCES = [
  { entityType: "department", arrayKey: "visibleDepartments", label: (r) => r.name, view: "departments" },
  { entityType: "project", arrayKey: "visibleProjects", label: (r) => r.name, view: "projects" },
  { entityType: "document", arrayKey: "visibleDocuments", label: (r) => r.filename, view: "documents" },
  { entityType: "task", arrayKey: "visibleTasks", label: (r) => r.title, view: "tasks" },
  { entityType: "contact", arrayKey: "visibleContacts", label: (r) => r.name, view: "crm" },
  { entityType: "deal", arrayKey: "visibleDeals", label: (r) => r.title, view: "crm" },
  { entityType: "supplier", arrayKey: "visibleSuppliers", label: (r) => r.name, view: "procurement" },
  { entityType: "purchase request", arrayKey: "visiblePurchaseRequests", label: (r) => r.title || r.description, view: "procurement" },
  { entityType: "purchase order", arrayKey: "visiblePurchaseOrders", label: (r) => r.title || r.description, view: "procurement" },
  { entityType: "product", arrayKey: "visibleProducts", label: (r) => r.name, view: "inventory" },
  { entityType: "invoice", arrayKey: "visibleInvoices", label: (r) => r.invoiceNumber, view: "finance" },
  { entityType: "expense", arrayKey: "visibleExpenses", label: (r) => r.description, view: "finance" },
  { entityType: "employee", arrayKey: "visibleEmployees", label: (r) => r.name || r.memberEmail, view: "hr" },
];

/** searchOrg({orgId, membership, email, query, limit}) — one call, every
 *  entity type the caller can already see. No-leak-by-construction: the
 *  arrays this reads all came from getAccessibleScope(), already scoped
 *  to this exact membership. */
export async function searchOrg({ orgId, membership, email, query, limit = 20 }) {
  const trimmed = (query || "").trim();
  if (trimmed.length < 2) return [];

  const scope = await getAccessibleScope({ orgId, membership, email });
  const results = [];

  for (const source of ENTITY_SOURCES) {
    const records = scope[source.arrayKey] || [];
    for (const record of records) {
      const matched = matchText(record, trimmed);
      if (!matched) continue;
      const label = source.label(record) || matched;
      results.push({
        entityType: source.entityType,
        id: record._id?.toString?.() || String(record._id),
        title: label,
        subtitle: source.entityType,
        view: source.view,
        actionUrl: `/business?view=${source.view}`,
      });
      if (results.length >= limit) return results;
    }
  }

  return results;
}
