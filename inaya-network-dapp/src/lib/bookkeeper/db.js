// src/lib/bookkeeper/db.js
//
// AI Bookkeeper SOW: collections and indexes. Bookkeeper collections hold PROPOSALS and EVIDENCE (captured documents, imported bank
// transactions, matches, review items, rules, reconciliations). Invoices, expenses, payments and purchase orders stay authoritative in their
// existing collections. Every query filters on orgId.

import { connectToDatabase } from "../mongodb.js";
import { getOrgCollections } from "../orgs.js";

const NAMES = {
  bkSources: "bk_sources", bkMatches: "bk_matches", bkReviewItems: "bk_review_items", bkRules: "bk_rules", bkMappings: "bk_mappings",
  bkReconciliations: "bk_reconciliations", bkSettings: "bk_settings", bkEvents: "bk_events", bkJobs: "bk_jobs", bkPeriods: "bk_periods", bkRuleHistory: "bk_rule_history",
};

export async function getBookkeeperCollections() {
  const { db } = await connectToDatabase();
  const out = { db };
  for (const [k, n] of Object.entries(NAMES)) out[k] = db.collection(n);
  const org = await getOrgCollections();
  Object.assign(out, { bkTransactions: org.bkTransactions, bkDocuments: org.bkDocuments, invoices: org.invoices, expenses: org.expenses, payments: org.payments, purchaseOrders: org.purchaseOrders, suppliers: org.suppliers, crmContacts: org.crmContacts, orgMembers: org.orgMembers, departments: org.departments, stockMovements: org.stockMovements });
  return out;
}

let ensured = false;
export async function ensureBookkeeperIndexes() {
  if (ensured) return;
  const c = await getBookkeeperCollections();
  await Promise.all([
    c.bkSources.createIndex({ orgId: 1, type: 1, status: 1 }),
    c.bkTransactions.createIndex({ orgId: 1, sourceId: 1, externalId: 1 }, { unique: true, partialFilterExpression: { externalId: { $type: "string" } } }),
    c.bkTransactions.createIndex({ orgId: 1, fingerprint: 1 }, { unique: true }),
    c.bkTransactions.createIndex({ orgId: 1, status: 1, date: -1 }),
    c.bkTransactions.createIndex({ orgId: 1, departmentId: 1, date: -1 }),
    c.bkDocuments.createIndex({ orgId: 1, fingerprint: 1 }, { unique: true }),
    c.bkDocuments.createIndex({ orgId: 1, sourceId: 1, externalId: 1 }, { unique: true, partialFilterExpression: { externalId: { $type: "string" } } }),
    c.bkDocuments.createIndex({ orgId: 1, status: 1, createdAt: -1 }),
    c.bkDocuments.createIndex({ orgId: 1, identityKey: 1 }),
    c.bkMatches.createIndex({ orgId: 1, transactionId: 1, status: 1 }),
    c.bkMatches.createIndex({ orgId: 1, targetKind: 1, targetId: 1 }),
    c.bkReviewItems.createIndex({ orgId: 1, status: 1, createdAt: -1 }),
    c.bkReviewItems.createIndex({ orgId: 1, dedupeKey: 1 }, { unique: true, partialFilterExpression: { status: "OPEN" } }),
    c.bkRules.createIndex({ orgId: 1, active: 1, priority: 1 }),
    c.bkMappings.createIndex({ orgId: 1, vendorKey: 1 }, { unique: true }),
    c.bkEvents.createIndex({ orgId: 1, sourceId: 1, eventId: 1 }, { unique: true }),
    c.bkEvents.createIndex({ createdAt: 1 }, { expireAfterSeconds: 90 * 86400 }),
    c.bkJobs.createIndex({ status: 1, nextRunAt: 1 }),
    c.bkJobs.createIndex({ orgId: 1, dedupeKey: 1 }, { unique: true, partialFilterExpression: { status: { $in: ["queued", "processing", "retrying"] } } }),
    c.bkSettings.createIndex({ orgId: 1 }, { unique: true }),
    c.bkReconciliations.createIndex({ orgId: 1, createdAt: -1 }),
    c.bkPeriods.createIndex({ orgId: 1, period: 1 }, { unique: true }),
  ]);
  ensured = true;
}
