// src/lib/navigation/launcher.js
//
// Business Workspace redesign (2026-10-18). Turns the 72-entry NAV_ITEMS
// list into (1) a short sidebar — everyday areas + the person's pinned apps
// + the page they're on — and (2) the grouped "All apps" launcher.
// Framework-free and pure, so it is unit-tested directly. Visibility is
// NEVER decided here: callers pass items already filtered by
// isNavItemVisible(), so role and industry gating are exactly as before.

// The everyday areas shown in the sidebar for everyone who can see them.
export const PRIMARY_NAV_KEYS = ["osHome", "tasks", "documents", "crm", "finance", "inventory", "procurement", "hr", "insights", "chat"];

// Friendlier sidebar/launcher wording; NAV_ITEMS labels (used by search and
// the command palette) are unchanged.
export const FRIENDLY_LABELS = { osHome: "Home", crm: "Customers", hr: "People", procurement: "Purchasing", chat: "Chat" };

export const LAUNCHER_GROUPS = [
  { id: "work", name: "Everyday work", blurb: "Your team’s day-to-day", keys: ["tasks", "documents", "projects", "departments", "notes", "chat", "meet", "approvals", "sign", "fileRequests", "shares", "office", "ai", "help"] },
  { id: "money", name: "Money", blurb: "Sales, billing and books", keys: ["finance", "crm", "inventory", "procurement", "bookkeeper", "documentAutomation", "escrow", "attestations", "support", "portalRequests"] },
  { id: "people", name: "People & insight", blurb: "Team, reports and automation", keys: ["hr", "insights", "brief", "whatChanged", "activity", "workflows", "whatIf", "executive", "docIntelligence"] },
  { id: "industry", name: "Your industry", blurb: "Built for your kind of organization", keys: ["health", "legal", "regulated", "financial", "government", "education"] },
  { id: "security", name: "Security & compliance", blurb: "Mostly for admins", keys: ["security", "aiActions", "adminDashboard", "governance", "complianceReadiness", "ransomware", "resilience", "resilienceTesting", "evidence", "auditTrail", "complianceEvidence", "trustRelationships", "aiSecurity", "identity"] },
  { id: "it", name: "Storage & IT", blurb: "For IT and admins", keys: ["deviceProtection", "gateway", "infrastructure", "storageManager", "nas", "cloudBackup", "storageControlPlane", "s3Compat", "dataSources", "databases", "sqlConsole", "mlStudio", "dataRooms", "integrations", "webhooks", "apiKeys", "enterpriseHardening"] },
  { id: "settings", name: "Account & settings", blurb: "Your company’s setup", keys: ["billing", "settings", "appearance"] },
];

// The first-run "What will you mainly use Inaya for?" choices and the apps
// each one pins. Pins the person can't see are dropped by the caller's filter.
export const USE_CASES = [
  { id: "run", title: "Running my business", desc: "Tasks, customers, invoices, stock and team in one place.", pins: ["approvals", "documentAutomation"] },
  { id: "money", title: "Finance and invoicing", desc: "Send invoices, track expenses and keep the books up to date.", pins: ["bookkeeper", "documentAutomation", "approvals"] },
  { id: "files", title: "Secure files and sharing", desc: "Store documents encrypted and share them safely with outsiders.", pins: ["shares", "sign", "fileRequests", "notes"] },
  { id: "it", title: "IT and security", desc: "Backups, devices, compliance and who has access to what.", pins: ["deviceProtection", "auditTrail", "complianceReadiness", "integrations"] },
];

export const labelFor = (item) => FRIENDLY_LABELS[item.key] || item.label;

// Descriptions for modules that have no page title entry of their own.
export const EXTRA_DESCRIPTIONS = {
  documents: "Encrypted files, organized by department and project.",
  projects: "Group work, tasks and documents by project.",
  departments: "Your company’s teams and who belongs to each.",
  bookkeeper: "Categorize transactions, match receipts and reconcile your bank.",
  docIntelligence: "Pull fields and answers out of uploaded documents.",
  databases: "Managed databases for your own applications.",
  mlStudio: "Run and evaluate AI and machine-learning models.",
  identity: "Connect Entra ID, Active Directory or SCIM and control who has access.",
};

/** Pins for a use case, or the default for people who skipped the question. */
export function defaultPins(useCaseId) {
  return (USE_CASES.find((u) => u.id === useCaseId) || USE_CASES[0]).pins.slice();
}

/**
 * The sidebar: primary areas, then pinned apps, then (if the current page is
 * neither) the current page, so the active item is always visible.
 * `visible` = NAV_ITEMS already filtered by isNavItemVisible.
 */
export function sidebarSections({ visible, pins = [], activeKey = null }) {
  const byKey = new Map(visible.map((i) => [i.key, i]));
  const primary = PRIMARY_NAV_KEYS.map((k) => byKey.get(k)).filter(Boolean);
  const shown = new Set(primary.map((i) => i.key));
  const pinned = [...new Set(pins)].map((k) => byKey.get(k)).filter((i) => i && !shown.has(i.key));
  pinned.forEach((i) => shown.add(i.key));
  // "browse" (Departments / Projects / Documents) is reached through "documents".
  const activeNavKey = activeKey === "browse" ? "documents" : activeKey;
  const current = activeNavKey && !shown.has(activeNavKey) && byKey.get(activeNavKey) ? byKey.get(activeNavKey) : null;
  return { primary, pinned, current, moreCount: Math.max(0, visible.length - primary.length - pinned.length) };
}

/** Launcher groups for the visible items, filtered by a search string and group id. */
export function launcherGroups({ visible, query = "", groupId = "all", describe = () => "" }) {
  const q = query.trim().toLowerCase();
  const byKey = new Map(visible.map((i) => [i.key, i]));
  const placed = new Set();
  const groups = LAUNCHER_GROUPS.map((g) => ({ ...g, items: g.keys.map((k) => byKey.get(k)).filter(Boolean) }));
  groups.forEach((g) => g.items.forEach((i) => placed.add(i.key)));
  const rest = visible.filter((i) => !placed.has(i.key));
  if (rest.length) groups.push({ id: "more", name: "More", blurb: "", items: rest });
  return groups
    .filter((g) => groupId === "all" || g.id === groupId)
    .map((g) => ({ ...g, items: g.items.filter((i) => !q || `${labelFor(i)} ${i.label} ${describe(i.key)}`.toLowerCase().includes(q)) }))
    .filter((g) => g.items.length);
}

// Per-person, per-company preferences kept in the browser (a convenience:
// losing them only means the defaults come back).
const prefKey = (orgId) => `inaya_bw_nav:${orgId}`;
export function readNavPrefs(storage, orgId) {
  try {
    const v = JSON.parse(storage.getItem(prefKey(orgId)) || "null");
    if (v && Array.isArray(v.pins)) return { pins: v.pins.filter((p) => typeof p === "string").slice(0, 20), useCase: v.useCase || null, welcomed: !!v.welcomed };
  } catch { /* storage blocked or bad JSON: defaults */ }
  return null;
}
export function writeNavPrefs(storage, orgId, prefs) {
  try { storage.setItem(prefKey(orgId), JSON.stringify({ pins: prefs.pins || [], useCase: prefs.useCase || null, welcomed: !!prefs.welcomed })); return true; } catch { return false; }
}
