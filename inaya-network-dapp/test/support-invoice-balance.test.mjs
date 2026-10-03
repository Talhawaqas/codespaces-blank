// test/support-invoice-balance.test.mjs -- the customer-facing outstanding balance. Pure functions over invoice rows.
// Run: node --env-file=.env.local --test --test-force-exit test/support-invoice-balance.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { outstandingOf, daysOverdue, invoiceView, summarizeInvoices } from "../src/lib/support/customers.js";

const NOW = Date.parse("2026-10-03T12:00:00Z");
const inv = (status, total, dueDate, currency = "USD") => ({ _id: `i-${status}-${total}`, invoiceNumber: `INV-${total}`, status, total, subtotal: total, currency, issueDate: "2026-09-01", dueDate });

test("only sent and overdue invoices are outstanding; paid, cancelled and draft owe nothing", () => {
  assert.equal(outstandingOf(inv("SENT", 500)), 500);
  assert.equal(outstandingOf(inv("OVERDUE", 250.5)), 250.5);
  for (const s of ["PAID", "CANCELLED", "DRAFT"]) assert.equal(outstandingOf(inv(s, 900)), 0, s);
  assert.equal(outstandingOf(inv("SENT", "not a number")), 0);
  assert.equal(outstandingOf(inv("SENT", -40)), 0, "a negative total never produces a negative balance");
});

test("days overdue counts whole days past the due date, only while something is owed", () => {
  assert.equal(daysOverdue(inv("OVERDUE", 100, "2026-09-26T12:00:00Z"), NOW), 7);
  assert.equal(daysOverdue(inv("SENT", 100, "2026-10-03T11:00:00Z"), NOW), 0, "less than a day late");
  assert.equal(daysOverdue(inv("SENT", 100, "2026-10-20T00:00:00Z"), NOW), 0, "not due yet");
  assert.equal(daysOverdue(inv("PAID", 100, "2026-01-01T00:00:00Z"), NOW), 0, "a settled invoice is never overdue");
  assert.equal(daysOverdue(inv("SENT", 100, null), NOW), 0);
  assert.equal(daysOverdue(inv("SENT", 100, "garbage"), NOW), 0);
});

test("invoiceView keeps its existing fields and adds the balance fields", () => {
  const v = invoiceView(inv("OVERDUE", 300, "2026-09-30T12:00:00Z"), NOW);
  assert.deepEqual(Object.keys(v).sort(), ["currency", "daysOverdue", "dueDate", "id", "invoiceNumber", "issueDate", "outstanding", "status", "subtotal", "total"]);
  assert.equal(v.outstanding, 300);
  assert.equal(v.daysOverdue, 3);
});

test("the summary totals what is owed per currency and how much of it is past due", () => {
  const views = [
    invoiceView(inv("SENT", 100, "2026-10-20T00:00:00Z"), NOW),
    invoiceView(inv("OVERDUE", 40.25, "2026-09-20T00:00:00Z"), NOW),
    invoiceView(inv("SENT", 60, "2026-09-25T00:00:00Z"), NOW),
    invoiceView(inv("SENT", 70, "2026-10-20T00:00:00Z", "EUR"), NOW),
    invoiceView(inv("PAID", 999, "2026-09-01T00:00:00Z"), NOW),
  ];
  assert.deepEqual(summarizeInvoices(views), { byCurrency: { USD: { outstanding: 200.25, overdue: 100.25, openInvoices: 3 }, EUR: { outstanding: 70, overdue: 0, openInvoices: 1 } } });
  assert.deepEqual(summarizeInvoices([]), { byCurrency: {} });
  assert.deepEqual(summarizeInvoices([invoiceView(inv("PAID", 10, "2026-01-01T00:00:00Z"), NOW)]), { byCurrency: {} }, "a customer who owes nothing has an empty summary");
});
