// src/lib/support/customers.js
//
// SOW §5.2, §13, §35: customer context. There is NO second customer table: a customer is a CRM contact
// (crm_contacts) found by verified email. The only support-specific record is the profile, which holds
// support-only attributes the CRM does not model (tier, account owner, timezone, notes).

import { getOrgCollections, toObjectId } from "../orgs.js";
import { getSupportCollections, ensureSupportIndexes } from "./db.js";
import { fail, normEmail, isEmail, nowIso } from "./common.js";

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The CRM contact for this email in this org, or null. Case-insensitive, exact. */
export async function findContactByEmail(orgId, email) {
  const e = normEmail(email);
  if (!isEmail(e)) return null;
  const { crmContacts } = await getOrgCollections();
  return crmContacts.findOne({ orgId: toObjectId(orgId), email: new RegExp(`^${esc(e)}$`, "i"), deletedAt: null });
}

/** All contacts that belong to the same company (for agent context, never for customer access). */
export async function companyContacts(orgId, contact) {
  if (!contact?.company) return [];
  const { crmContacts } = await getOrgCollections();
  return crmContacts.find({ orgId: toObjectId(orgId), company: contact.company, deletedAt: null }).project({ name: 1, email: 1 }).limit(50).toArray();
}

/** Creates a CRM lead for an open-signup portal user. Returns null if the org has no department to attach it to. */
export async function createLeadContact({ orgId, email, name }) {
  const { crmContacts, departments } = await getOrgCollections();
  const dept = await departments.findOne({ orgId: toObjectId(orgId) }, { sort: { createdAt: 1 } });
  if (!dept) return null;
  const now = nowIso();
  const doc = { orgId: toObjectId(orgId), departmentId: dept._id, type: "LEAD", name: name || normEmail(email).split("@")[0], email: normEmail(email), phone: null, company: null, taxId: null, paymentTerms: null, billingAddress: {}, shippingAddress: {}, notes: "Created from the customer portal", createdByEmail: "customer-portal", createdAt: now, updatedAt: now, deletedAt: null };
  const r = await crmContacts.insertOne(doc);
  return { ...doc, _id: r.insertedId };
}

export async function getProfile(orgId, email) {
  await ensureSupportIndexes();
  const { supportCustomerProfiles } = await getSupportCollections();
  return supportCustomerProfiles.findOne({ orgId: toObjectId(orgId), email: normEmail(email) });
}

export async function upsertProfile({ orgId, email, tier, accountOwnerEmail, timezone, notes, actorEmail, tiers }) {
  if (!isEmail(normEmail(email))) return fail("A valid customer email is required.");
  if (tier !== undefined && tier !== null && Array.isArray(tiers) && !tiers.includes(tier)) return fail(`tier must be one of ${tiers.join(", ")}.`);
  const set = { updatedAt: nowIso(), updatedBy: actorEmail };
  if (tier !== undefined) set.tier = tier; if (accountOwnerEmail !== undefined) set.accountOwnerEmail = accountOwnerEmail ? normEmail(accountOwnerEmail) : null;
  if (timezone !== undefined) set.timezone = timezone; if (notes !== undefined) set.notes = String(notes || "").slice(0, 2000);
  await ensureSupportIndexes();
  const { supportCustomerProfiles } = await getSupportCollections();
  await supportCustomerProfiles.updateOne({ orgId: toObjectId(orgId), email: normEmail(email) }, { $set: set, $setOnInsert: { createdAt: nowIso() } }, { upsert: true });
  return { profile: await getProfile(orgId, email) };
}

/**
 * Agent-facing customer context (SOW §13): CRM contact, profile, support history and, only when the agent may
 * see invoices, that customer's invoices. Everything is read from existing records.
 */
export async function customerContext({ orgId, email, includeInvoices }) {
  const { supportTickets } = await getSupportCollections();
  const [contact, profile, history] = await Promise.all([
    findContactByEmail(orgId, email),
    getProfile(orgId, email),
    supportTickets.find({ orgId: toObjectId(orgId), "requester.email": normEmail(email) }).sort({ createdAt: -1 }).limit(10).project({ number: 1, subject: 1, status: 1, createdAt: 1, priority: 1 }).toArray(),
  ]);
  const [colleagues, invoices] = await Promise.all([contact ? companyContacts(orgId, contact) : [], includeInvoices && contact ? invoicesForContact(orgId, contact._id, 10) : null]);
  const out = { contact: contact ? { id: String(contact._id), name: contact.name, email: contact.email, company: contact.company || null, type: contact.type || null, phone: contact.phone || null } : null, profile: profile ? { tier: profile.tier || null, accountOwnerEmail: profile.accountOwnerEmail || null, timezone: profile.timezone || null, notes: profile.notes || null } : null, history: history.map((t) => ({ id: String(t._id), number: t.number, subject: t.subject, status: t.status, priority: t.priority, createdAt: t.createdAt })), colleagues: contact ? colleagues.filter((c) => String(c._id) !== String(contact._id)).map((c) => ({ name: c.name, email: c.email })) : [] };
  if (invoices) out.invoices = invoices;
  return out;
}

/** Read-only projection of the authoritative invoice records for one CRM contact (never a copy). */
export async function invoicesForContact(orgId, contactId, limit = 25) {
  const { invoices } = await getOrgCollections();
  const rows = await invoices.find({ orgId: toObjectId(orgId), contactId: toObjectId(contactId), deletedAt: null, status: { $ne: "DRAFT" } }).sort({ issueDate: -1 }).limit(limit).toArray();
  return rows.map(invoiceView);
}

export function invoiceView(i) {
  return { id: String(i._id), invoiceNumber: i.invoiceNumber, issueDate: i.issueDate, dueDate: i.dueDate, status: i.status, currency: i.currency, total: i.total, subtotal: i.subtotal };
}
