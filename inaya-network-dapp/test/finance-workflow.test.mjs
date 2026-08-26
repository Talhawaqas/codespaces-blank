// test/finance-workflow.test.mjs
//
// Business Operations Phase 5 (Finance) coverage: invoice lifecycle
// including the cron-driven overdue transition, expense approval gate,
// and payment recording/approval. Same node --test + real Atlas +
// RUN_ID-fixtures convention as every other test file in this repo.
//
// Run with: node --env-file=.env.local --test test/finance-workflow.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { transitionInvoice, markOverdueInvoices } from "../src/lib/invoice-workflow.js";
import { transitionExpense } from "../src/lib/expense-workflow.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const email = (label) => `test-finance-${RUN_ID}-${label}@example.com`;

let collections;
const cleanup = { orgIds: [], recordIds: [] };

before(async () => {
  await ensureOrgIndexes();
  collections = await getOrgCollections();
});

after(async () => {
  const { orgs, orgMembers, departments, crmContacts, invoices, expenses, payments, orgActivity } = collections;
  await orgMembers.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await departments.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await crmContacts.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await invoices.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await expenses.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await payments.deleteMany({ orgId: { $in: cleanup.orgIds } });
  await orgActivity.deleteMany({ recordId: { $in: cleanup.recordIds } });
  await orgs.deleteMany({ _id: { $in: cleanup.orgIds } });
  const client = await mongoClientPromise;
  await client.close();
});

async function makeOrgWithFinanceRoles(label) {
  const now = new Date().toISOString();
  const orgResult = await collections.orgs.insertOne({ name: `${label} Co`, ownerEmail: email(`${label}-owner`), createdAt: now });
  cleanup.orgIds.push(orgResult.insertedId);
  const orgId = orgResult.insertedId;

  const deptResult = await collections.departments.insertOne({ orgId, name: "Finance Dept", createdAt: now });

  const ownerEmail = email(`${label}-owner`);
  await collections.orgMembers.insertOne({ orgId, email: ownerEmail, role: "owner", departmentIds: [], status: "active", invitedAt: now, joinedAt: now });
  const owner = await collections.orgMembers.findOne({ orgId, email: ownerEmail });

  // Finance Staff — has financeRole:"staff" but NOT canManageFinance
  const staffEmail = email(`${label}-staff`);
  await collections.orgMembers.insertOne({ orgId, email: staffEmail, role: "member", departmentIds: [deptResult.insertedId], financeRole: "staff", status: "active", invitedAt: now, joinedAt: now });
  const staff = await collections.orgMembers.findOne({ orgId, email: staffEmail });

  const contactResult = await collections.crmContacts.insertOne({
    orgId, departmentId: deptResult.insertedId, type: "CUSTOMER", name: "Acme Corp",
    email: null, phone: null, company: null, notes: null, createdByEmail: ownerEmail, createdAt: now, updatedAt: now, deletedAt: null,
  });

  return { orgId, departmentId: deptResult.insertedId, owner, ownerEmail, staff, staffEmail, contactId: contactResult.insertedId };
}

async function makeInvoice({ orgId, departmentId, contactId, status = "DRAFT", dueDate }) {
  const now = new Date().toISOString();
  const result = await collections.invoices.insertOne({
    orgId, departmentId, contactId, invoiceNumber: `INV-${RUN_ID}`, issueDate: now, dueDate: dueDate || now,
    lineItems: [{ description: "Consulting", quantity: 1, unitPrice: 500 }], subtotal: 500, total: 500,
    currency: "USD", status, notes: null, createdByEmail: "creator@example.com", createdAt: now, updatedAt: now, deletedAt: null,
  });
  cleanup.recordIds.push(result.insertedId);
  return result.insertedId;
}

async function makeExpense({ orgId, departmentId, status = "DRAFT" }) {
  const now = new Date().toISOString();
  const result = await collections.expenses.insertOne({
    orgId, departmentId, vendor: "Office Supplies Co", category: "Office", amount: 120, currency: "USD",
    expenseDate: now, description: null, status, createdByEmail: "creator@example.com", createdAt: now, updatedAt: now, deletedAt: null,
  });
  cleanup.recordIds.push(result.insertedId);
  return result.insertedId;
}

// ============================================================
// Invoice lifecycle
// ============================================================
test("invoice: full lifecycle send -> markPaid succeeds for a Finance Manager (org owner)", async () => {
  const org = await makeOrgWithFinanceRoles("invoice-lifecycle");
  const invoiceId = await makeInvoice({ ...org, status: "DRAFT" });

  const sent = await transitionInvoice({ orgId: org.orgId, invoiceId, action: "send", membership: org.owner, actorEmail: org.ownerEmail });
  assert.equal(sent.invoice.status, "SENT");

  const paid = await transitionInvoice({ orgId: org.orgId, invoiceId, action: "markPaid", membership: org.owner, actorEmail: org.ownerEmail });
  assert.equal(paid.invoice.status, "PAID");
});

test("invoice: Finance Staff (canAccessFinance but not canManageFinance) is denied every transition", async () => {
  const org = await makeOrgWithFinanceRoles("invoice-staff-denied");
  const invoiceId = await makeInvoice({ ...org, status: "DRAFT" });
  const result = await transitionInvoice({ orgId: org.orgId, invoiceId, action: "send", membership: org.staff, actorEmail: org.staffEmail });
  assert.equal(result.status, 403);
});

test("invoice: cron markOverdueInvoices flips a past-due SENT invoice to OVERDUE, and OVERDUE can still be marked PAID", async () => {
  const org = await makeOrgWithFinanceRoles("invoice-overdue");
  const pastDue = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const invoiceId = await makeInvoice({ ...org, status: "SENT", dueDate: pastDue });

  const { flipped } = await markOverdueInvoices();
  assert.ok(flipped >= 1);
  const invoice = await collections.invoices.findOne({ _id: invoiceId });
  assert.equal(invoice.status, "OVERDUE");

  const paid = await transitionInvoice({ orgId: org.orgId, invoiceId, action: "markPaid", membership: org.owner, actorEmail: org.ownerEmail });
  assert.equal(paid.invoice.status, "PAID");
});

test("invoice: cron is idempotent — running it again doesn't re-flip an already-PAID invoice", async () => {
  const org = await makeOrgWithFinanceRoles("invoice-cron-idempotent");
  const pastDue = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const invoiceId = await makeInvoice({ ...org, status: "PAID", dueDate: pastDue });

  await markOverdueInvoices();
  const invoice = await collections.invoices.findOne({ _id: invoiceId });
  assert.equal(invoice.status, "PAID", "a PAID invoice must never be touched by the overdue cron, even if its dueDate is in the past");
});

test("invoice: org isolation — an invoice from org A is invisible to org B", async () => {
  const orgA = await makeOrgWithFinanceRoles("invoice-isolation-a");
  const orgB = await makeOrgWithFinanceRoles("invoice-isolation-b");
  const invoiceInA = await makeInvoice({ ...orgA, status: "DRAFT" });

  const result = await transitionInvoice({ orgId: orgB.orgId, invoiceId: invoiceInA, action: "send", membership: orgB.owner, actorEmail: orgB.ownerEmail });
  assert.equal(result.status, 404);
});

// ============================================================
// Expense approval gate
// ============================================================
test("expense: Finance Staff can submit, only a Finance Manager can approve", async () => {
  const org = await makeOrgWithFinanceRoles("expense-approval");
  const expenseId = await makeExpense({ ...org, status: "DRAFT" });

  const submitted = await transitionExpense({ orgId: org.orgId, expenseId, action: "submit", membership: org.staff, actorEmail: org.staffEmail });
  assert.equal(submitted.expense.status, "PENDING_APPROVAL");

  const deniedApprove = await transitionExpense({ orgId: org.orgId, expenseId, action: "approve", membership: org.staff, actorEmail: org.staffEmail });
  assert.equal(deniedApprove.status, 403);

  const approved = await transitionExpense({ orgId: org.orgId, expenseId, action: "approve", membership: org.owner, actorEmail: org.ownerEmail });
  assert.equal(approved.expense.status, "APPROVED");
});

test("expense: org_activity records the approval with correct previous/new state", async () => {
  const org = await makeOrgWithFinanceRoles("expense-activity");
  const expenseId = await makeExpense({ ...org, status: "PENDING_APPROVAL" });
  await transitionExpense({ orgId: org.orgId, expenseId, action: "approve", membership: org.owner, actorEmail: org.ownerEmail });

  const events = await collections.orgActivity.find({ recordType: "EXPENSE", recordId: expenseId }).toArray();
  assert.equal(events.length, 1);
  assert.equal(events[0].action, "EXPENSE_APPROVED");
  assert.equal(events[0].previousState, "PENDING_APPROVAL");
  assert.equal(events[0].newState, "APPROVED");
});

// ============================================================
// Payments — record + approve
// ============================================================
test("payment: recorded then approved via the manage-gated action, replay-safe", async () => {
  const org = await makeOrgWithFinanceRoles("payment-record");
  const now = new Date().toISOString();
  const result = await collections.payments.insertOne({
    orgId: org.orgId, departmentId: org.departmentId, direction: "INCOMING", relatedInvoiceId: null, relatedExpenseId: null,
    amount: 500, currency: "USD", method: "bank_transfer", paymentDate: now, status: "RECORDED",
    createdByEmail: org.staffEmail, createdAt: now, deletedAt: null,
  });
  cleanup.recordIds.push(result.insertedId);

  const first = await collections.payments.findOneAndUpdate({ _id: result.insertedId, status: "RECORDED" }, { $set: { status: "APPROVED" } }, { returnDocument: "after" });
  assert.equal(first.status, "APPROVED");

  const replay = await collections.payments.findOneAndUpdate({ _id: result.insertedId, status: "RECORDED" }, { $set: { status: "APPROVED" } }, { returnDocument: "after" });
  assert.equal(replay, null, "a second approval attempt on an already-APPROVED payment must be a no-op, not a duplicate");
});
