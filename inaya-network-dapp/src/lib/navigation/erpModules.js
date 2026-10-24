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
// Every NAV_ITEMS key appears in exactly one module, and the inventory test
// fails if one is added to NAV_ITEMS without a home here.

import { NAV_ITEMS } from "./navItems.js";
import { labelFor } from "./launcher.js";

// Views that are not NAV_ITEMS entries but are reachable in the workspace.
// "apps" is the All apps launcher; it is always visible.
export const ERP_EXTRA_VIEWS = ["apps"];

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
    id: "sales", label: "Sales", icon: "sales", home: "crm",
    groups: [
      { id: "customers", label: "Customers and deals", items: ["crm"] },
      { id: "service", label: "Customer service", items: ["support", "portalRequests"] },
    ],
  },
  {
    id: "purchasing", label: "Purchasing", icon: "purchasing", home: "procurement",
    groups: [
      { id: "buying", label: "Buying", items: ["procurement"] },
      { id: "payments", label: "Supplier payments", items: ["escrow"] },
    ],
  },
  {
    id: "inventory", label: "Inventory", icon: "inventory", home: "inventory",
    groups: [{ id: "stock", label: "Stock", items: ["inventory"] }],
  },
  {
    id: "accounting", label: "Accounting", icon: "accounting", home: "finance",
    groups: [
      { id: "books", label: "Books", items: ["finance", "bookkeeper"] },
      { id: "paperwork", label: "Paperwork", items: ["documentAutomation", "attestations"] },
    ],
  },
  {
    id: "people", label: "People", icon: "people", home: "hr",
    groups: [{ id: "staff", label: "Staff", items: ["hr"] }],
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
    groups: [{ id: "industry", label: "Industry", items: ["health", "legal", "regulated", "financial", "government"] }],
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

// ERP-specific wording where the standard label reads oddly inside a
// module's task panel. Everything else uses the standard friendly label.
const ERP_LABELS = {
  osHome: "Overview",
  apps: "All apps",
  crm: "Customers and deals",
  support: "Support desk",
  procurement: "Purchasing",
  finance: "Invoices and accounts",
  hr: "Employees and leave",
  inventory: "Products and stock",
  security: "Account security",
};

const NAV_BY_KEY = new Map(NAV_ITEMS.map((i) => [i.key, i]));

/** Display label for a view key in ERP mode. */
export function erpLabelFor(key) {
  if (ERP_LABELS[key]) return ERP_LABELS[key];
  const item = NAV_BY_KEY.get(key);
  return item ? labelFor(item) : key;
}

/** Icon key (business ui/icons.js) for a view key, or null. */
export function erpIconFor(key) {
  return NAV_BY_KEY.get(key)?.icon || null;
}

/** Every view key ERP mode places, in module order (each appears once). */
export function erpPlacedKeys() {
  return ERP_MODULES.flatMap((m) => m.groups.flatMap((g) => g.items));
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
      .map((g) => ({ ...g, items: g.items.filter((k) => visible.has(k)).map((k) => ({ key: k, label: erpLabelFor(k), icon: erpIconFor(k) })) }))
      .filter((g) => g.items.length);
    if (!groups.length) return null;
    const first = groups[0].items[0].key;
    const home = m.home && visible.has(m.home) ? m.home : first;
    if (m.id === "industry") {
      const label = erpLabelFor(first);
      return { ...m, label, home, groups: [{ ...groups[0], label }] };
    }
    return { ...m, home, groups };
  }).filter(Boolean);
}

/** The module id that owns a view. "browse" resolves through the Departments/Projects/Documents section. */
export function erpModuleFor(view, browseSection = "documents") {
  const key = view === "browse" ? browseSection : view;
  const found = ERP_MODULES.find((m) => m.groups.some((g) => g.items.includes(key)));
  return found ? found.id : "home";
}

/** The task-panel item key that should show as selected for the current view. */
export function erpActiveItem(view, browseSection = "documents") {
  return view === "browse" ? browseSection : view;
}
