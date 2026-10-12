// src/lib/navigation/navItems.js
//
// Command Palette + Virtual Guide SOW. The single source of truth for
// "what Business Workspace views exist and who can see them" — moved out
// of src/app/business/page.js (a "use client" component) so server-side
// lib code (src/lib/search/unified.js) can import it too. Previously
// src/lib/search/unified.js kept its own hand-written, 17-entry copy
// (PAGES) that was never updated alongside this real 72-entry list,
// which is the actual root cause of the command palette missing most
// modules. Framework-free on purpose: no React, no DB, safe to import
// from anywhere.

import { hasAdminRole } from "../orgGates.js";

// UI Enhancement Specs v2, §3 -- each item's `group` drives the sidebar's
// micro-heading chunking. Order here is also render order, so items in
// the same group stay contiguous; GROUP_LABELS below defines display order
// and text independently of these internal keys.
export const NAV_ITEMS = [
  { key: "osHome", label: "OS Home", icon: "dashboard", group: "core" },
  { key: "insights", label: "Insights", icon: "insights", group: "core" },
  { key: "brief", label: "Brief", icon: "insights", group: "core" },
  { key: "whatChanged", label: "What Changed?", icon: "insights", group: "core" },
  { key: "chat", label: "Secure Chat", icon: "aiAssistant", group: "collaboration" },
  { key: "meet", label: "Inaya Meet", icon: "aiAssistant", group: "collaboration" },
  { key: "notes", label: "Secure Notes", icon: "documents", group: "collaboration" },
  { key: "adminDashboard", label: "Admin Dashboard", icon: "insights", manageOnly: true, adminRole: ["securityAdmin", "storageAdmin", "complianceAdmin", "dataGovernanceAdmin", "deviceAdmin", "vdrAdmin", "integrationAdmin"], group: "trust" },
  { key: "webhooks", label: "Webhooks", icon: "integrations", manageOnly: true, adminRole: "integrationAdmin", group: "enterprise" },
  { key: "governance", label: "Governance", icon: "enterpriseHardening", manageOnly: true, adminRole: ["dataGovernanceAdmin", "securityAdmin"], group: "trust" },
  { key: "complianceReadiness", label: "Compliance Readiness", icon: "enterpriseHardening", manageOnly: true, adminRole: ["complianceAdmin", "securityAdmin"], group: "trust" },
  { key: "gateway", label: "Sovereign Gateway", icon: "enterpriseHardening", group: "trust" },
  { key: "deviceProtection", label: "Device Protection", icon: "enterpriseHardening", group: "trust" },
  { key: "infrastructure", label: "Infrastructure", icon: "enterpriseHardening", group: "trust" },
  { key: "ransomware", label: "Ransomware Signals", icon: "enterpriseHardening", manageOnly: true, adminRole: "securityAdmin", group: "trust" },
  { key: "shares", label: "Shares", icon: "documents", group: "collaboration" },
  { key: "fileRequests", label: "File Requests", icon: "documents", group: "collaboration" },
  { key: "office", label: "Microsoft 365 and Outlook", icon: "integrations", group: "collaboration" },
  { key: "portalRequests", label: "Customer Requests", icon: "documents", manageOnly: true, adminRole: "helpdeskAdmin", group: "collaboration" },
  { key: "departments", label: "Departments", icon: "departments", group: "operations" },
  { key: "projects", label: "Projects", icon: "projects", group: "operations" },
  { key: "documents", label: "Documents", icon: "documents", group: "operations" },
  { key: "tasks", label: "Tasks", icon: "tasks", group: "operations" },
  { key: "crm", label: "CRM", icon: "crm", group: "operations" },
  { key: "procurement", label: "Procurement", icon: "procurement", group: "operations" },
  { key: "inventory", label: "Inventory", icon: "inventory", group: "operations" },
  { key: "finance", label: "Finance", icon: "finance", group: "operations" },
  { key: "bookkeeper", label: "AI Bookkeeper", icon: "finance", group: "operations" },
  { key: "documentAutomation", label: "Document Automation", icon: "documents", group: "operations" },
  { key: "hr", label: "HR", icon: "hr", group: "operations" },
  { key: "sign", label: "Inaya Sign", icon: "documents", group: "operations" },
  { key: "escrow", label: "Milestone Escrow", icon: "finance", group: "operations" },
  { key: "storageManager", label: "DePIN Storage", icon: "resilience", group: "operations" },
  { key: "attestations", label: "Attestations", icon: "financial", group: "operations" },
  { key: "health", label: "Health OS", icon: "health", verticalOnly: "healthcare", group: "industry" },
  { key: "legal", label: "Legal OS", icon: "legal", verticalOnly: "legal", group: "industry" },
  { key: "regulated", label: "Regulated OS", icon: "regulated", verticalOnly: "regulated", group: "industry" },
  { key: "financial", label: "Financial OS", icon: "financial", verticalOnly: ["financial", "private_capital"], group: "industry" },
  { key: "government", label: "Government OS", icon: "government", verticalOnly: "government", group: "industry" },
  { key: "security", label: "Account Security", icon: "activity", group: "trust" },
  { key: "resilience", label: "Security & Resilience Controls", icon: "resilience", manageOnly: true, group: "trust" },
  { key: "resilienceTesting", label: "Resilience Testing", icon: "resilience", manageOnly: true, group: "trust" },
  { key: "approvals", label: "Approvals", icon: "approvals", manageOnly: true, group: "trust" },
  { key: "aiActions", label: "AI Action Requests", icon: "aiAssistant", group: "trust" },
  { key: "workflows", label: "Automations", icon: "aiAssistant", group: "operations" },
  { key: "support", label: "Customer Support", icon: "activity", group: "operations" },
  { key: "help", label: "Help & Support", icon: "activity", group: "trust" },
  { key: "docIntelligence", label: "Document Intelligence", icon: "insights", group: "operations" },
  { key: "databases", label: "Databases", icon: "activity", manageOnly: true, group: "enterprise" },
  { key: "mlStudio", label: "AI/ML Studio", icon: "aiAssistant", manageOnly: true, group: "enterprise" },
  { key: "identity", label: "Identity & Access", icon: "lock", manageOnly: true, group: "enterprise" },
  { key: "evidence", label: "Evidence", icon: "lock", group: "trust" },
  { key: "whatIf", label: "What-If Studio", icon: "insights", group: "trust" },
  { key: "auditTrail", label: "Audit Trail", icon: "activity", manageOnly: true, group: "trust" },
  { key: "complianceEvidence", label: "Compliance Evidence", icon: "lock", manageOnly: true, group: "trust" },
  { key: "trustRelationships", label: "Cross-Org Trust", icon: "activity", manageOnly: true, group: "trust" },
  { key: "activity", label: "Activity", icon: "activity", group: "trust" },
  { key: "integrations", label: "Integrations", icon: "integrations", manageOnly: true, group: "enterprise" },
  { key: "apiKeys", label: "API Keys", icon: "integrations", manageOnly: true, group: "enterprise" },
  { key: "storageControlPlane", label: "Storage Control Plane", icon: "health", manageOnly: true, group: "enterprise" },
  { key: "dataSources", label: "Data Sources", icon: "integrations", manageOnly: true, group: "enterprise" },
  { key: "nas", label: "Sovereign NAS", icon: "integrations", manageOnly: true, group: "enterprise" },
  { key: "aiSecurity", label: "AI Security", icon: "lock", manageOnly: false, group: "enterprise" },
  { key: "sqlConsole", label: "SQL Console", icon: "activity", manageOnly: true, group: "enterprise" },
  { key: "s3Compat", label: "S3-Compatible Storage", icon: "integrations", manageOnly: true, group: "enterprise" },
  { key: "executive", label: "Executive", icon: "executive", manageOnly: true, group: "enterprise" },
  { key: "dataRooms", label: "Data Rooms", icon: "dataRooms", manageOnly: true, group: "enterprise" },
  { key: "cloudBackup", label: "Cloud Backup", icon: "health", manageOnly: true, group: "enterprise" },
  { key: "enterpriseHardening", label: "Export & Migration", icon: "enterpriseHardening", manageOnly: true, group: "enterprise" },
  { key: "ai", label: "AI Assistant", icon: "aiAssistant", group: "settings" },
  { key: "billing", label: "Billing", icon: "billing", manageOnly: true, group: "settings" },
  { key: "settings", label: "Settings", icon: "settings", manageOnly: true, group: "settings" },
];

export const GROUP_LABELS = {
  core: "Core",
  collaboration: "Collaboration",
  operations: "Operations",
  industry: "Industry",
  trust: "Trust & Security",
  enterprise: "Enterprise",
  settings: "Settings",
};

/** The exact visibility predicate the sidebar has always used (src/app/business/page.js),
 *  lifted out so the command palette's search index can apply identical gating instead of
 *  drifting from it (the 17-vs-72 entry gap this module fixes was exactly that kind of drift). */
export function isNavItemVisible(item, { canManage, membership, vertical }) {
  return (
    (!item.manageOnly || canManage || (item.adminRole && hasAdminRole(membership, item.adminRole, { read: true }))) &&
    (!item.verticalOnly || (Array.isArray(item.verticalOnly) ? item.verticalOnly.includes(vertical) : item.verticalOnly === vertical))
  );
}

// A handful of modules whose label alone is a weak search term (acronyms,
// or a name that doesn't suggest what you'd actually search for). Every
// item without an override here still gets a real, matchable search string
// from its label + group — this map only improves matching, it's never
// required for an item to be findable.
const SEARCH_SYNONYMS = {
  crm: "crm customers leads deals pipeline sales contacts",
  hr: "hr employees staff leave payroll",
  procurement: "procurement purchase orders rfq suppliers vendors",
  finance: "finance invoices expenses payments accounting",
  aiActions: "ai actions approvals pending review",
  mlStudio: "ai ml machine learning models",
  s3Compat: "s3 storage api compatible credentials",
  sqlConsole: "sql database query console",
  nas: "nas network attached storage appliances shares",
  dataRooms: "data rooms vdr diligence investors",
  whatIf: "what if simulation digital twin scenario",
};

/** Search terms for one nav item -- used by the command palette (unifiedSearch). */
export function searchWordsFor(item) {
  const override = SEARCH_SYNONYMS[item.key];
  if (override) return override.toLowerCase();
  return `${item.label} ${GROUP_LABELS[item.group] || ""}`.toLowerCase();
}
