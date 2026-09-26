// test/_support-fixtures.mjs -- real-database fixtures for the Customer Portal & Customer Service tests.
// Real MongoDB, real membership permissions, real audit chain, real CRM contacts and invoices. Only what is
// external to Inaya is replaced, and only where a test says so: the model provider (scripted through the
// existing __setAiProvider seam) and outbound HTTP for webhooks.

import { randomBytes } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes, createSession } from "../src/lib/orgs.js";
import { getSupportCollections } from "../src/lib/support/db.js";
import { updateSettings, getSettings } from "../src/lib/support/settings.js";
import { requestLogin, verifyLogin } from "../src/lib/support/portalAuth.js";
import mongoClientPromise from "../src/lib/mongodb.js";

export const RUN = randomBytes(3).toString("hex");
export const created = { orgIds: [] };
export let c;
export let sc;

process.env.SUPPORT_PORTAL_RETURN_LINK = "1";
if (!process.env.INTEGRATION_ENCRYPTION_KEY) process.env.INTEGRATION_ENCRYPTION_KEY = randomBytes(32).toString("base64");

export async function setup() {
  await ensureOrgIndexes();
  c = await getOrgCollections();
  sc = await getSupportCollections();
  return { c, sc };
}

const day = 86400000;
const iso = (d) => new Date(Date.now() + d * day).toISOString();

/** An organization with a support agent, a manager, a non-support member, two customers of one company and a stranger. */
export async function makeSupportOrg(label, { slug = true, settings = {} } = {}) {
  const now = new Date().toISOString();
  const orgId = (await c.orgs.insertOne({ name: `sup-${RUN}-${label}`, createdAt: now })).insertedId;
  created.orgIds.push(orgId);
  const dept = (await c.departments.insertOne({ orgId, name: "Support", createdAt: now })).insertedId;
  const member = async (k, extra) => {
    const email = `sup-${RUN}-${label}-${k}@example.com`;
    await c.orgMembers.insertOne({ orgId, email, role: "member", departmentIds: [dept], status: "active", invitedAt: now, joinedAt: now, ...extra });
    return { email, membership: await c.orgMembers.findOne({ orgId, email }) };
  };
  const owner = await member("owner", { role: "owner" });
  const agent = await member("agent", { supportRole: "agent" });
  const agent2 = await member("agent2", { supportRole: "agent" });
  const manager = await member("manager", { supportRole: "manager" });
  const plain = await member("plain", {});

  const contact = async (k, name, company) => {
    const email = `cust-${RUN}-${label}-${k}@customer.example`;
    const id = (await c.crmContacts.insertOne({ orgId, departmentId: dept, type: "CUSTOMER", name, email, phone: null, company, taxId: null, paymentTerms: null, billingAddress: {}, shippingAddress: {}, notes: null, createdByEmail: owner.email, createdAt: now, updatedAt: now, deletedAt: null })).insertedId;
    return { id, email, name };
  };
  const alice = await contact("alice", "Alice Customer", "Acme");
  const bob = await contact("bob", "Bob Colleague", "Acme");
  const invoice = async (contactId, n, total, status) => (await c.invoices.insertOne({ orgId, departmentId: dept, contactId, invoiceNumber: `INV-${RUN}-${label}-${n}`, issueDate: iso(-30), dueDate: iso(-5), lineItems: [{ description: "Services", quantity: 1, unitPrice: total }], subtotal: total, total, currency: "USD", status, notes: null, createdByEmail: owner.email, createdAt: now, updatedAt: now, deletedAt: null })).insertedId;
  const aliceInvoice = await invoice(alice.id, "A1", 1500, "OVERDUE");
  await invoice(bob.id, "B1", 700, "SENT");

  const portalSlug = `sup-${RUN}-${label}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const patch = { portalEnabled: true, ...(slug ? { portalSlug } : {}), ...settings };
  const st = await updateSettings({ orgId, patch, actorEmail: owner.email });
  if (st.error) throw new Error(`settings: ${st.error}`);
  return { orgId, oid: String(orgId), dept, owner, agent, agent2, manager, plain, alice, bob, aliceInvoiceNumber: `INV-${RUN}-${label}-A1`, aliceInvoiceId: aliceInvoice, slug: portalSlug, settings: await getSettings(orgId) };
}

/** Signs a customer in through the real magic-link flow (dev link returned for automated tests only). */
export async function portalSession(org, email) {
  const r = await requestLogin({ orgId: org.oid, settings: org.settings, email, ip: `t-${Math.random()}` });
  if (!r.devLink) throw new Error("no dev link (customer not eligible?)");
  const token = new URL(r.devLink).searchParams.get("token");
  const v = await verifyLogin({ orgId: org.oid, settings: org.settings, token });
  if (v.error) throw new Error(v.error);
  return { user: v.user, sessionToken: v.sessionToken, token };
}

export async function cookieFor(email) { return (await createSession(email)).sessionToken; }

export async function cleanup() {
  const ids = created.orgIds;
  if (ids.length) {
    for (const name of Object.keys(sc || {})) { if (name === "db") continue; try { await sc[name].deleteMany({ orgId: { $in: ids } }); } catch { /* collection without orgId */ } }
    for (const k of ["orgMembers", "departments", "crmContacts", "invoices", "apiKeys", "orgActivity", "auditChainEntries", "auditChainHeads", "businessEvents", "orgDocuments", "projects", "orgs"]) { try { await c[k].deleteMany(k === "orgs" ? { _id: { $in: ids } } : { orgId: { $in: ids } }); } catch { /* ignore */ }
    try { await sc.db.collection("notifications").deleteMany({ orgId: { $in: ids } }); await sc.db.collection("s3_owner_keys").deleteMany({ ownerId: { $in: ids.map(String) } }); await sc.db.collection("s3_owner_keys").deleteMany({ ownerId: { $in: ids } }); } catch { /* ignore */ } }
  }
  await (await mongoClientPromise).close();
}
