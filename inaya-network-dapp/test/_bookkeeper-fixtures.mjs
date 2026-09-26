// test/_bookkeeper-fixtures.mjs -- real-database fixtures for the AI Bookkeeper tests. Real MongoDB, real membership/permission rules, real audit
// chain and Evidence Graph, real encrypted storage. Only the outside world (AI model, WhatsApp Graph) is played by the tests.
import { randomBytes } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes, createSession } from "../src/lib/orgs.js";
import { getBookkeeperCollections, ensureBookkeeperIndexes } from "../src/lib/bookkeeper/db.js";
import { createSource } from "../src/lib/bookkeeper/sources.js";
import mongoClientPromise from "../src/lib/mongodb.js";

export const RUN = randomBytes(3).toString("hex");
export const created = { orgIds: [] };
export let c; export let bc;
if (!process.env.INTEGRATION_ENCRYPTION_KEY) process.env.INTEGRATION_ENCRYPTION_KEY = randomBytes(32).toString("base64");
const now = () => new Date().toISOString();

export async function setup() { await ensureOrgIndexes(); await ensureBookkeeperIndexes(); c = await getOrgCollections(); bc = await getBookkeeperCollections(); return { c, bc }; }

/** Organization with owner, a Finance Manager, Finance Staff, a Sales-only member; departments Finance/Sales; a supplier, a customer with an open invoice, a PO. */
export async function makeOrg(label) {
  const name = `bk-${RUN}-${label}`;
  const orgId = (await c.orgs.insertOne({ name, createdAt: now() })).insertedId; created.orgIds.push(orgId);
  const dept = async (n) => (await c.departments.insertOne({ orgId, name: n, createdAt: now() })).insertedId;
  const finance = await dept("Finance"); const sales = await dept("Sales");
  const member = async (k, extra = {}) => { const email = `bk-${RUN}-${label}-${k}@example.com`; await c.orgMembers.insertOne({ orgId, email, role: "member", departmentIds: [], status: "active", invitedAt: now(), joinedAt: now(), ...extra }); return email; };
  const owner = await member("owner", { role: "owner" });
  const manager = await member("manager", { financeRole: "manager", departmentIds: [finance] });
  const staff = await member("staff", { financeRole: "staff", departmentIds: [finance] });
  const salesUser = await member("sales", { departmentIds: [sales] });
  const supplier = (await c.suppliers.insertOne({ orgId, departmentId: finance, name: "ABC Ltd", contactEmail: "billing@abc.example", status: "ACTIVE", createdAt: now(), deletedAt: null })).insertedId;
  const contact = (await c.crmContacts.insertOne({ orgId, departmentId: finance, type: "CUSTOMER", name: "Carol Buyer", company: "Acme Customer Inc", email: "carol@acme.example", createdAt: now(), deletedAt: null })).insertedId;
  const invoice = (await c.invoices.insertOne({ orgId, departmentId: finance, contactId: contact, invoiceNumber: "INV-2001", issueDate: "2026-03-01", dueDate: "2026-03-31", lineItems: [{ description: "Services", quantity: 1, unitPrice: 5000 }], subtotal: 5000, total: 5000, currency: "USD", status: "SENT", createdByEmail: owner, createdAt: now(), updatedAt: now(), deletedAt: null })).insertedId;
  const po = (await c.purchaseOrders.insertOne({ orgId, departmentId: finance, supplierId: supplier, items: [{ description: "Consulting hours", quantity: 10, unitPrice: 90, receivedQuantity: 10 }], currency: "USD", status: "RECEIVED", createdByEmail: owner, createdAt: now(), updatedAt: now(), deletedAt: null })).insertedId;
  const bank = await createSource({ orgId, type: "BANK_ACCOUNT", name: "Operating account", departmentId: String(finance), currency: "USD", actor: owner });
  if (bank.error) throw new Error(bank.error);
  const membership = async (email) => c.orgMembers.findOne({ orgId, email });
  return { orgId, oid: String(orgId), name, finance, sales, owner, manager, staff, salesUser, supplier, contact, invoice, po, bankId: bank.source.sourceId, membership };
}

export const cookieFor = async (email) => (await createSession(email)).sessionToken;

export async function cleanup() {
  const ids = created.orgIds;
  if (ids.length) {
    for (const k of ["bkSources", "bkMatches", "bkReviewItems", "bkRules", "bkMappings", "bkReconciliations", "bkSettings", "bkEvents", "bkJobs", "bkPeriods", "bkRuleHistory", "bkTransactions", "bkDocuments"]) { try { await bc[k].deleteMany({ orgId: { $in: ids } }); } catch { /* ignore */ } }
    for (const k of ["orgMembers", "departments", "suppliers", "crmContacts", "invoices", "expenses", "payments", "purchaseOrders", "orgActivity", "auditChainEntries", "auditChainHeads", "businessEvents", "aiActionRequests", "tasks", "workflowRequests", "orgs"]) {
      try { if (k === "orgs") await c.orgs.deleteMany({ _id: { $in: ids } }); else await c[k].deleteMany({ orgId: { $in: ids } }); } catch { /* ignore */ }
    }
    try { await bc.db.collection("notifications").deleteMany({ orgId: { $in: ids } }); } catch { /* ignore */ }
  }
  try { await bc.db.collection("sessions").deleteMany({ email: new RegExp(`^bk-${RUN}-`) }); } catch { /* ignore */ }
  await (await mongoClientPromise).close();
}
