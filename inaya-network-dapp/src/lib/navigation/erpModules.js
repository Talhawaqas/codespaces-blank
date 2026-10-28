// src/lib/navigation/erpModules.js
//
// ERP mode (docs/erp-mode-plan.md). Arranges every Business Workspace view
// into the classic desktop-ERP structure: a row of module tiles across the
// top, and a task panel of collapsible groups down the left. Framework-free
// and pure, so it is unit-tested directly (test-ui/erpModules.test.js).
//
// Visibility is NEVER decided here: callers pass the keys of NAV_ITEMS
// already filtered by isNavItemVisible(), so role, admin-role and industry
// (verticalOnly) gating stay exactly as they are in the standard layout. A
// Legal OS company therefore only ever sees the Legal OS tile, never another
// industry's.
//
// Task-panel items are strings:
//   "view"                 open a screen
//   "view:section"         open one of the screen's own sections (its tabs)
//   "view:section!new"     open that section's own "New ..." form
// Every view belongs to exactly one module, and the inventory test fails if a
// NAV_ITEMS key is added without a home here. Screens with sections that are
// not listed here still get them in the task panel: the screen reports its
// tabs at runtime (components/business/erp/ErpNavContext.js).

import { NAV_ITEMS } from "./navItems.js";
import { labelFor } from "./launcher.js";

// Views that are not NAV_ITEMS entries but are reachable in the workspace.
// "apps" is the All apps launcher; "moduleOverview" is ERP mode's per-module
// Overview (its section is the module id). A module whose only visible item
// would be its Overview is dropped, so an Overview never appears on its own.
export const ERP_EXTRA_VIEWS = ["apps", "moduleOverview"];
const OVERVIEW = "moduleOverview";

export const ERP_MODULES = [
  {
    id: "home", label: "Home", icon: "home", home: "osHome",
    groups: [
      { id: "dashboards", label: "My dashboards", items: ["osHome", "brief", "whatChanged"] },
      { id: "work", label: "Waiting on me", items: ["approvals", "aiActions"] },
      { id: "everything", label: "Everything", items: ["apps"] },
    ],
  },
  {
    id: "sales", label: "Sales", icon: "sales", home: "moduleOverview:sales",
    groups: [
      { id: "overview", label: "Overview", items: ["moduleOverview:sales"] },
      { id: "tasks", label: "My tasks", items: ["crm:contacts!new", "crm:deals!new", "crm:orders!new"] },
      { id: "customers", label: "Customers and deals", items: ["crm:contacts", "crm:deals", "crm:orders"] },
      { id: "service", label: "Customer service", items: ["support", "portalRequests"] },
    ],
  },
  {
    id: "purchasing", label: "Purchasing", icon: "purchasing", home: "moduleOverview:purchasing",
    groups: [
      { id: "overview", label: "Overview", items: ["moduleOverview:purchasing"] },
      { id: "tasks", label: "My tasks", items: ["procurement:requests!new", "procurement:orders!new", "procurement:suppliers!new"] },
      { id: "buying", label: "Buying", items: ["procurement:requests", "procurement:orders", "procurement:suppliers"] },
      { id: "reports", label: "Reports", items: ["procurement:reports"] },
      { id: "payments", label: "Supplier payments", items: ["escrow"] },
    ],
  },
  {
    id: "inventory", label: "Inventory", icon: "inventory", home: "moduleOverview:inventory",
    groups: [
      { id: "overview", label: "Overview", items: ["moduleOverview:inventory"] },
      { id: "tasks", label: "My tasks", items: ["inventory:products!new", "inventory:production!new", "inventory:warehouses!new"] },
      { id: "stock", label: "Stock", items: ["inventory:products", "inventory:batches", "inventory:movements", "inventory:warehouses"] },
      { id: "production", label: "Production", items: ["inventory:production", "inventory:boms"] },
    ],
  },
  {
    id: "accounting", label: "Accounting", icon: "accounting", home: "moduleOverview:accounting",
    groups: [
      { id: "overview", label: "Overview", items: ["moduleOverview:accounting"] },
      { id: "tasks", label: "My tasks", items: ["finance:invoices!new", "finance:expenses!new", "finance:payments!new", "finance:ledger!new"] },
      { id: "books", label: "Books", items: ["finance:invoices", "finance:expenses", "finance:payments", "finance:ledger", "bookkeeper"] },
      { id: "reports", label: "Reports", items: ["finance:reports"] },
      { id: "paperwork", label: "Paperwork", items: ["documentAutomation", "attestations"] },
    ],
  },
  {
    id: "people", label: "People", icon: "people", home: "moduleOverview:people",
    groups: [
      { id: "overview", label: "Overview", items: ["moduleOverview:people"] },
      { id: "tasks", label: "My tasks", items: ["hr:employees!new", "hr:leave!new"] },
      { id: "staff", label: "Staff", items: ["hr:employees", "hr:leave", "hr:managers", "hr:orgChart", "hr:onboarding"] },
    ],
  },
  {
    id: "documents", label: "Documents", icon: "documents", home: "documents",
    groups: [
      { id: "files", label: "Files", items: ["documents", "shares", "fileRequests", "dataRooms"] },
      { id: "tools", label: "Work with documents", items: ["sign", "notes", "docIntelligence", "office"] },
    ],
  },
  {
    id: "workplace", label: "Workplace", icon: "workplace", home: "tasks",
    groups: [
      { id: "tasks", label: "My tasks", items: ["tasks:list!new"] },
      { id: "work", label: "Work", items: ["tasks", "projects", "departments"] },
      { id: "communicate", label: "Communicate", items: ["chat", "meet"] },
      { id: "assist", label: "Automation and help", items: ["workflows", "ai", "help"] },
    ],
  },
  {
    id: "reports", label: "Reports", icon: "reports", home: "insights",
    groups: [
      { id: "reports", label: "Reports", items: ["insights", "executive", "activity"] },
      { id: "analysis", label: "Analysis", items: ["whatIf", "evidence"] },
    ],
  },
  {
    // One tile, labelled with the company's own industry OS. Only the
    // visible one survives the caller's isNavItemVisible filter.
    id: "industry", label: "Industry", icon: "industry", home: null,
    groups: [{ id: "industry", label: "Industry", items: ["health", "legal", "regulated", "financial", "government", "education"] }],
  },
  {
    id: "admin", label: "Admin", icon: "admin", home: "adminDashboard",
    groups: [
      { id: "account", label: "My account", items: ["security", "appearance"] },
      { id: "security", label: "Security", items: ["adminDashboard", "identity", "deviceProtection", "ransomware", "aiSecurity", "resilience", "resilienceTesting"] },
      { id: "compliance", label: "Compliance", items: ["governance", "complianceReadiness", "complianceEvidence", "auditTrail", "trustRelationships"] },
      { id: "it", label: "Storage and IT", items: ["storageManager", "storageControlPlane", "nas", "gateway", "infrastructure", "cloudBackup", "s3Compat", "dataSources", "databases", "sqlConsole", "mlStudio", "enterpriseHardening"] },
      { id: "integrations", label: "Integrations", items: ["integrations", "webhooks", "apiKeys"] },
      { id: "company", label: "Company setup", items: ["settings", "billing"] },
    ],
  },
];

// ERP wording. Keys are task-panel item strings; a plain view key also
// covers that view's own title in the panel.
const ERP_LABELS = {
  osHome: "Overview",
  "moduleOverview:sales": "Sales overview",
  "moduleOverview:purchasing": "Purchasing overview",
  "moduleOverview:inventory": "Inventory overview",
  "moduleOverview:accounting": "Accounting overview",
  "moduleOverview:people": "People overview",
  apps: "All apps",
  security: "Account security",
  support: "Support desk",
  "crm:contacts!new": "New customer or lead",
  "crm:deals!new": "New deal",
  "crm:contacts": "Customers and leads",
  "crm:deals": "Deals and pipeline",
  "crm:orders!new": "New sales order",
  "crm:orders": "Sales orders",
  "procurement:requests!new": "New purchase request",
  "procurement:orders!new": "New purchase order",
  "procurement:suppliers!new": "New supplier",
  "procurement:requests": "Purchase requests",
  "procurement:orders": "Purchase orders",
  "procurement:suppliers": "Suppliers",
  "procurement:reports": "Purchasing reports",
  "inventory:products!new": "New product",
  "inventory:warehouses!new": "New warehouse",
  "inventory:products": "Products and stock",
  "inventory:batches": "Batches & expiry",
  "inventory:production!new": "New production order",
  "inventory:production": "Production orders",
  "inventory:boms": "Bills of materials",
  "inventory:movements": "Stock movements",
  "inventory:warehouses": "Warehouses",
  "finance:invoices!new": "New invoice",
  "finance:expenses!new": "New expense",
  "finance:payments!new": "Record a payment",
  "finance:ledger!new": "Manual journal entry",
  "finance:invoices": "Invoices",
  "finance:expenses": "Expenses",
  "finance:payments": "Payments",
  "finance:ledger": "General ledger",
  "finance:reports": "Financial statements",
  "hr:employees!new": "New employee",
  "hr:leave!new": "Request leave",
  "hr:employees": "Employees",
  "hr:leave": "Leave requests",
  "hr:managers": "Department managers",
  "hr:orgChart": "Org chart",
  "hr:onboarding": "Onboarding",
  "tasks:list!new": "New task",
  tasks: "Tasks",
};

const NAV_BY_KEY = new Map(NAV_ITEMS.map((i) => [i.key, i]));

/** Splits a task-panel item string into its parts. */
export function parseErpItem(item) {
  const [target, action = null] = item.split("!");
  const [view, section = null] = target.split(":");
  return { key: item, view, section, action };
}

/** Display label for a task-panel item (or plain view key) in ERP mode. */
export function erpLabelFor(key) {
  if (ERP_LABELS[key]) return ERP_LABELS[key];
  const item = NAV_BY_KEY.get(parseErpItem(key).view);
  return item ? labelFor(item) : key;
}

/** Icon key (business ui/icons.js) for a view key, or null. */
export function erpIconFor(key) {
  const { view } = parseErpItem(key);
  if (view === OVERVIEW) return "dashboard";
  return NAV_BY_KEY.get(view)?.icon || null;
}

/** Every view ERP mode places, once each, in module order. */
export function erpPlacedViews() {
  return [...new Set(ERP_MODULES.flatMap((m) => m.groups.flatMap((g) => g.items.map((i) => parseErpItem(i).view))))];
}

/** The section a view opens on when none is named: its first listed section, if it has any. */
export function erpDefaultSection(view) {
  if (view === OVERVIEW) return null;
  for (const m of ERP_MODULES) for (const g of m.groups) for (const i of g.items) {
    const p = parseErpItem(i);
    if (p.view === view && p.section && !p.action) return p.section;
  }
  return null;
}

/** Whether ERP_MODULES lists this view's sections itself (so runtime-reported tabs are not shown again). */
export function erpListsSections(view) {
  return erpDefaultSection(view) !== null;
}

/**
 * The modules this person can see, with groups and items filtered.
 * `visibleKeys` = keys of NAV_ITEMS already passed through isNavItemVisible.
 * A module with nothing visible is dropped. The industry tile takes the
 * label of the company's own industry OS.
 */
export function erpLayout({ visibleKeys }) {
  const visible = new Set([...visibleKeys, ...ERP_EXTRA_VIEWS]);
  return ERP_MODULES.map((m) => {
    const groups = m.groups
      .map((g) => ({ ...g, items: g.items.map(parseErpItem).filter((p) => visible.has(p.view)).map((p) => ({ ...p, label: erpLabelFor(p.key), icon: erpIconFor(p.key) })) }))
      .filter((g) => g.items.length);
    if (!groups.some((g) => g.items.some((i) => i.view !== OVERVIEW))) return null;
    const firstOpen = groups.flatMap((g) => g.items).find((i) => !i.action) || groups[0].items[0];
    const home = m.home && visible.has(parseErpItem(m.home).view) ? parseErpItem(m.home) : firstOpen;
    if (m.id === "industry") {
      const label = erpLabelFor(firstOpen.view);
      return { ...m, label, home, groups: [{ ...groups[0], label }] };
    }
    return { ...m, home, groups };
  }).filter(Boolean);
}

/** The module id that owns a view. "browse" resolves through the Departments/Projects/Documents
 *  section, and a module Overview through its section (the module id). */
export function erpModuleFor(view, browseSection = "documents", section = null) {
  if (view === OVERVIEW && ERP_MODULES.some((m) => m.id === section)) return section;
  const key = view === "browse" ? browseSection : view;
  const found = ERP_MODULES.find((m) => m.groups.some((g) => g.items.some((i) => parseErpItem(i).view === key)));
  return found ? found.id : "home";
}

/** The task-panel item key that shows as selected for the current view and section. */
export function erpActiveItem(view, browseSection = "documents", section = null) {
  if (view === "browse") return browseSection;
  if (view === OVERVIEW) return `${OVERVIEW}:${section}`;
  const listed = erpDefaultSection(view);
  if (!listed) return view;
  return `${view}:${section || listed}`;
}

/** The "New ..." task-panel item for a view's section (or its default section), if ERP mode has one. */
export function erpNewItemFor(view, section = null) {
  const sec = section || erpDefaultSection(view);
  for (const m of ERP_MODULES) for (const g of m.groups) for (const i of g.items) {
    const p = parseErpItem(i);
    if (p.view === view && p.action === "new" && (p.section === sec || (!erpListsSections(view) && p.section))) return p;
  }
  return null;
}
