// test/_docauto-fixtures.mjs -- shared real-database fixtures for the
// Document Automation test files (same node:test + real Atlas + RUN_ID
// convention as finance-workflow.test.mjs; no mocks of the system under test).

import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import mongoClientPromise from "../src/lib/mongodb.js";
import { PROVIDERS } from "../src/lib/pinningProviders/index.js";
import { createHash } from "node:crypto";

export const RUN_ID = randomUUID().slice(0, 8);
export const email = (label) => `test-docauto-${RUN_ID}-${label}@example.com`;

export const cleanup = { orgIds: [] };
export let collections;

export async function setup() {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
  return collections;
}

export async function teardown() {
  const c = collections;
  const ids = { $in: cleanup.orgIds };
  const byOrg = { orgId: ids };
  await Promise.all([
    c.orgMembers.deleteMany(byOrg), c.departments.deleteMany(byOrg), c.crmContacts.deleteMany(byOrg), c.crmDeals.deleteMany(byOrg),
    c.invoices.deleteMany(byOrg), c.payments.deleteMany(byOrg), c.purchaseOrders.deleteMany(byOrg), c.suppliers.deleteMany(byOrg),
    c.generatedDocuments.deleteMany(byOrg), c.documentSequences.deleteMany({ orgId: ids }), c.documentNumberLedger.deleteMany(byOrg),
    c.documentTemplates.deleteMany(byOrg), c.documentAutomationSettings.deleteMany(byOrg), c.documentDeliveries.deleteMany(byOrg),
    c.documentAccessEvents.deleteMany(byOrg), c.documentJobs.deleteMany(byOrg), c.documentMetrics.deleteMany(byOrg),
    c.documentShares.deleteMany(byOrg), c.businessEvents.deleteMany(byOrg), c.orgActivity.deleteMany(byOrg),
    c.auditChainEntries.deleteMany(byOrg), c.auditChainHeads.deleteMany(byOrg), c.sodRules.deleteMany(byOrg),
    c.dataRooms.deleteMany(byOrg), c.dataRoomExternalMagicLinks.deleteMany(byOrg), c.dataRoomExternalSessions.deleteMany(byOrg), c.dataRoomAccessLog.deleteMany(byOrg),
    c.orgDocuments.deleteMany(byOrg), c.projects.deleteMany(byOrg),
    c.db.collection("notifications").deleteMany(byOrg),
    c.documentTemplateCounters ? c.documentTemplateCounters.deleteMany({ _id: { $regex: cleanup.orgIds.map((i) => String(i)).join("|") || "^$" } }) : null,
    c.orgs.deleteMany({ _id: ids }),
  ].filter(Boolean));
  const client = await mongoClientPromise;
  await client.close();
}

/** An org with: owner (finance manager by role), a SECOND finance manager
 *  (for segregation-of-duties), a finance staff member (view only), an
 *  ordinary member of another department, a customer with full
 *  billing/shipping addresses. */
export async function makeOrg(label, { withStaff = true } = {}) {
  const now = new Date().toISOString();
  const org = await collections.orgs.insertOne({ name: `${label} Holdings Ltd`, createdAt: now });
  const orgId = org.insertedId;
  cleanup.orgIds.push(orgId);
  const finDept = (await collections.departments.insertOne({ orgId, name: "Finance", createdAt: now })).insertedId;
  const otherDept = (await collections.departments.insertOne({ orgId, name: "Marketing", createdAt: now })).insertedId;

  const member = async (label2, extra) => {
    const e = email(`${label}-${label2}`);
    await collections.orgMembers.insertOne({ orgId, email: e, role: "member", departmentIds: [], status: "active", invitedAt: now, joinedAt: now, ...extra });
    return { email: e, membership: await collections.orgMembers.findOne({ orgId, email: e }) };
  };
  const owner = await member("owner", { role: "owner" });
  const managerB = await member("mgrB", { departmentIds: [finDept], financeRole: "manager" });
  const staff = withStaff ? await member("staff", { departmentIds: [finDept], financeRole: "staff" }) : null;
  const marketer = await member("mkt", { departmentIds: [otherDept] });

  const contact = (await collections.crmContacts.insertOne({
    orgId, departmentId: finDept, type: "CUSTOMER", name: "Acme Corporation", email: "ap@acme.example", phone: "+1 555 0100", company: "Acme Holdings Inc.",
    taxId: "US-99-1234567", paymentTerms: "Net 30",
    billingAddress: { line1: "500 Market Street", line2: "Suite 12", city: "San Francisco", region: "CA", postalCode: "94105", country: "United States" },
    shippingAddress: { line1: "12 Harbour Way", city: "Oakland", region: "CA", postalCode: "94607", country: "United States" },
    notes: null, createdByEmail: owner.email, createdAt: now, updatedAt: now, deletedAt: null,
  })).insertedId;
  return { orgId, finDept, otherDept, owner, managerB, staff, marketer, contactId: contact };
}

export async function makeInvoice({ orgId, departmentId, contactId, lineItems, currency = "USD", status = "SENT", extra = {} }) {
  const now = new Date().toISOString();
  const items = lineItems || [{ description: "Enterprise platform implementation", quantity: 10, unitPrice: 2500 }];
  const total = items.reduce((s, i) => s + i.quantity * i.unitPrice, 0);
  const r = await collections.invoices.insertOne({
    orgId, departmentId, contactId, invoiceNumber: `INV-TEST-${randomUUID().slice(0, 6).toUpperCase()}`, issueDate: now, dueDate: new Date(Date.now() + 30 * 86400000).toISOString(),
    lineItems: items, subtotal: total, total, currency, status, notes: "Thank you for your business.", createdByEmail: "creator@example.com", createdAt: now, updatedAt: now, deletedAt: null, ...extra,
  });
  return r.insertedId;
}


// ---------------------------------------------------------------------
// In-memory pinning providers, for the bulk suites only. The real
// encrypt -> shard -> pin -> fetch -> decrypt pipeline still runs; only the
// network hop to Pinata/Filebase is replaced (so a suite that generates a
// dozen documents finishes in seconds and is not hostage to a provider's
// plan limits). The end-to-end acceptance test does NOT use this -- it goes
// through the real providers. `storageControl.down = true` simulates a full
// storage outage for the failure-handling tests.
// ---------------------------------------------------------------------
export const storageControl = { down: false, pinCalls: 0, failNextPins: 0 };
const memoryStore = new Map();

export function installMemoryProviders() {
  const make = (providerName) => ({
    isConfigured: () => true,
    async pin(content, { name } = {}) {
      storageControl.pinCalls++;
      if (storageControl.down) throw new Error(`pinningProviders/${providerName}: simulated storage outage`);
      if (storageControl.failNextPins > 0) { storageControl.failNextPins--; throw new Error(`pinningProviders/${providerName}: simulated transient failure`); }
      const ref = `mem-${providerName}-${RUN_ID}-${name}`;
      memoryStore.set(ref, content);
      const contentHash = createHash("sha256").update(typeof content === "string" ? content : Buffer.from(content)).digest("hex");
      return { provider: providerName, cid: `bafymem${contentHash.slice(0, 40)}`, providerRef: ref, contentHash };
    },
    async fetchReplica(ref) {
      if (storageControl.down) throw new Error(`pinningProviders/${providerName}: simulated storage outage`);
      if (!memoryStore.has(ref)) throw new Error(`pinningProviders/${providerName}: replica not found`);
      return memoryStore.get(ref);
    },
    async getPinStatus(ref) { return memoryStore.has(ref); },
    async unpin(ref) { memoryStore.delete(ref); },
  });
  PROVIDERS.pinata = make("pinata");
  PROVIDERS.filebase = make("filebase");
}
