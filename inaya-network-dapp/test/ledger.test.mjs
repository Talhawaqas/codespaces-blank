// test/ledger.test.mjs
//
// Business Workspace gap closure, Batch 2 — double-entry general ledger
// (src/lib/ledger.js): balancing rules, every automatic posting rule,
// idempotent/concurrent sync, no double count, reversals, non-USD
// conversion, and that the trial balance / P&L / balance sheet agree.
//
// Run with: node --env-file=.env.local --test test/ledger.test.mjs

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getOrgCollections, ensureOrgIndexes } from "../src/lib/orgs.js";
import { validateLines, syncLedger, syncAllLedgers, postEntry, reverseEntry, listEntries, trialBalance, profitAndLoss, balanceSheet, createAccount, ACCOUNTS } from "../src/lib/ledger.js";
import { convertAt } from "../src/lib/fx-rates.js";
import mongoClientPromise from "../src/lib/mongodb.js";

const RUN_ID = randomUUID().slice(0, 8);
const ACTOR = `test-ledger-${RUN_ID}@example.com`;
let c;
const cleanup = { orgIds: [] };

before(async () => { await ensureOrgIndexes(); c = await getOrgCollections(); });
after(async () => {
  const f = { orgId: { $in: cleanup.orgIds } };
  await Promise.all([c.invoices, c.expenses, c.payments, c.ledgerAccounts, c.journalEntries, c.orgActivity, c.auditChainEntries, c.auditChainHeads].map((x) => x.deleteMany(f)));
  await c.orgs.deleteMany({ _id: { $in: cleanup.orgIds } });
  await (await mongoClientPromise).close();
});

async function makeOrg(label) {
  const org = await c.orgs.insertOne({ name: `ledger-${RUN_ID}-${label}`, createdAt: new Date().toISOString() });
  cleanup.orgIds.push(org.insertedId);
  return { orgId: org.insertedId, id: org.insertedId.toString() };
}
const base = (fx) => ({ orgId: fx.orgId, departmentId: fx.orgId, deletedAt: null, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z" });
const invoice = (fx, extra) => c.invoices.insertOne({ ...base(fx), invoiceNumber: `INV-${randomUUID().slice(0, 4)}`, currency: "USD", issueDate: "2026-09-02", ...extra });
const event = (fx, recordId, action, timestamp) => c.orgActivity.insertOne({ eventId: randomUUID(), orgId: fx.orgId, recordType: "X", recordId, actorEmail: ACTOR, action, previousState: null, newState: null, timestamp, metadata: {} });

test("validateLines: balance, one side per line, known accounts", () => {
  const codes = new Set(["1000", "4000"]);
  assert.match(validateLines([{ accountCode: "1000", debit: 10 }, { accountCode: "4000", credit: 9 }], codes).error, /doesn't balance/);
  assert.match(validateLines([{ accountCode: "1000", debit: 10, credit: 10 }, { accountCode: "4000", credit: 10 }], codes).error, /either a debit or a credit/);
  assert.match(validateLines([{ accountCode: "9999", debit: 10 }, { accountCode: "4000", credit: 10 }], codes).error, /Unknown account/);
  assert.ok(validateLines([{ accountCode: "1000", debit: 0.1 }, { accountCode: "1000", debit: 0.2 }, { accountCode: "4000", credit: 0.3 }], codes).lines, "0.1 + 0.2 balances 0.3 in cents");
});

test("syncLedger: every posting rule, no double count, and the three reports agree", async () => {
  const fx = await makeOrg("rules");
  await invoice(fx, { total: 100, status: "SENT" });
  const paid = await invoice(fx, { total: 200, status: "PAID" });
  await event(fx, paid.insertedId, "INVOICE_PAID", "2026-09-15T10:00:00.000Z");
  const exp = await c.expenses.insertOne({ ...base(fx), vendor: "Office Co", category: "Supplies", amount: 50, currency: "USD", expenseDate: "2026-09-05", status: "APPROVED" });
  await c.expenses.insertOne({ ...base(fx), vendor: "Pending Co", amount: 999, currency: "USD", status: "PENDING_APPROVAL" });
  await c.payments.insertOne({ ...base(fx), direction: "OUTGOING", amount: 50, currency: "USD", status: "APPROVED", relatedExpenseId: exp.insertedId, paymentDate: "2026-09-10" });
  await c.payments.insertOne({ ...base(fx), direction: "INCOMING", amount: 200, currency: "USD", status: "APPROVED", relatedInvoiceId: paid.insertedId, paymentDate: "2026-09-15" });
  await c.payments.insertOne({ ...base(fx), direction: "INCOMING", amount: 30, currency: "USD", status: "APPROVED", paymentDate: "2026-09-12" });
  await c.payments.insertOne({ ...base(fx), direction: "INCOMING", amount: 77, currency: "USD", status: "RECORDED", paymentDate: "2026-09-12" });

  const result = await syncLedger(fx.id);
  assert.deepEqual(result.errors, []);
  assert.equal(result.posted, 6, "AR(100), AR(200), cash-in(200), expense(50), expense paid(50), other income(30)");

  const paidEntry = (await listEntries(fx.id)).find((e) => e.source?.event === "PAID");
  assert.equal(paidEntry.date, "2026-09-15", "entry date comes from the activity log");

  const tb = await trialBalance(fx.id);
  assert.equal(tb.balanced, true);
  const pnl = await profitAndLoss(fx.id);
  assert.equal(pnl.totalRevenue, 330);
  assert.equal(pnl.totalExpenses, 50);
  assert.equal(pnl.netIncome, 280);
  const bs = await balanceSheet(fx.id);
  const amount = (list, code) => list.find((r) => r.code === code)?.amount || 0;
  assert.equal(amount(bs.assets, ACCOUNTS.CASH), 180, "200 + 30 - 50; the invoice-linked payment is not counted twice");
  assert.equal(amount(bs.assets, ACCOUNTS.AR), 100);
  assert.equal(amount(bs.liabilities, ACCOUNTS.AP), 0);
  assert.equal(bs.retainedEarnings, 280);
  assert.equal(bs.balanced, true);
  assert.equal(bs.totalAssets, bs.totalLiabilitiesAndEquity);
});

test("syncLedger: repeated and concurrent runs never double-post", async () => {
  const fx = await makeOrg("idem");
  await invoice(fx, { total: 40, status: "PAID" });
  await Promise.all([syncLedger(fx.id), syncLedger(fx.id), syncLedger(fx.id)]);
  assert.equal((await syncLedger(fx.id)).posted, 0);
  assert.equal(await c.journalEntries.countDocuments({ orgId: fx.orgId }), 2);
});

test("cancelling a posted invoice reverses it; cancelling an unposted one posts nothing", async () => {
  const fx = await makeOrg("cancel");
  const inv = await invoice(fx, { total: 120, status: "SENT" });
  await syncLedger(fx.id);
  await c.invoices.updateOne({ _id: inv.insertedId }, { $set: { status: "CANCELLED" } });
  await invoice(fx, { total: 999, status: "CANCELLED" });
  const r = await syncLedger(fx.id);
  assert.equal(r.posted, 1);
  const bs = await balanceSheet(fx.id);
  assert.equal(bs.totalAssets, 0);
  assert.equal((await profitAndLoss(fx.id)).totalRevenue, 0);
});

test("non-USD invoices post in USD with the reference rate recorded", async () => {
  const fx = await makeOrg("fx");
  await invoice(fx, { total: 92, currency: "EUR", status: "SENT" });
  await invoice(fx, { total: 10, currency: "XYZ", status: "SENT" });
  const r = await syncLedger(fx.id);
  assert.equal(r.posted, 1);
  assert.equal(r.errors.length, 1, "an unsupported currency is reported, never guessed");
  const [entry] = await listEntries(fx.id);
  // Daily live rates may exist in the shared database, so the expectation is
  // whatever convertAt gives for that entry's date (static: 92 EUR = 100 USD).
  const expected = await convertAt(92, "EUR", "USD", entry.date);
  assert.equal(entry.total, expected.convertedAmount);
  assert.equal(entry.lines[0].fxSource, expected.source);
  assert.equal(entry.lines[0].originalCurrency, "EUR");
  assert.equal(entry.lines[0].originalAmount, 92);
  assert.ok(entry.lines[0].ratesAsOf);
});

test("manual entries: custom accounts, balanced only, reversed exactly once", async () => {
  const fx = await makeOrg("manual");
  assert.ok((await createAccount({ orgId: fx.id, code: "1500", name: "Equipment", type: "ASSET", actorEmail: ACTOR })).account);
  assert.equal((await createAccount({ orgId: fx.id, code: "1500", name: "Dup", type: "ASSET", actorEmail: ACTOR })).status, 409);
  assert.equal((await postEntry({ orgId: fx.id, date: "2026-10-01", lines: [{ accountCode: "1500", debit: 500 }, { accountCode: ACCOUNTS.EQUITY, credit: 400 }], actorEmail: ACTOR })).status, 400);
  const { entry } = await postEntry({ orgId: fx.id, date: "2026-10-01", memo: "Owner contributed equipment", lines: [{ accountCode: "1500", debit: 500 }, { accountCode: ACCOUNTS.EQUITY, credit: 500 }], actorEmail: ACTOR });
  assert.equal((await balanceSheet(fx.id)).balanced, true);

  const first = await reverseEntry({ orgId: fx.id, entryId: entry._id.toString(), actorEmail: ACTOR });
  const second = await reverseEntry({ orgId: fx.id, entryId: entry._id.toString(), actorEmail: ACTOR });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.entry._id.toString(), first.entry._id.toString());
  assert.equal((await reverseEntry({ orgId: fx.id, entryId: first.entry._id.toString(), actorEmail: ACTOR })).status, 409);
  assert.equal((await balanceSheet(fx.id)).totalAssets, 0);
});

test("one org's ledger never sees another org's records", async () => {
  const a = await makeOrg("iso-a");
  const b = await makeOrg("iso-b");
  await invoice(a, { total: 10, status: "SENT" });
  await syncLedger(b.id);
  assert.equal((await listEntries(b.id)).length, 0);
});

test("syncAllLedgers (daily cron): syncs every org with finance records in scope", async () => {
  const a = await makeOrg("cron-a");
  const b = await makeOrg("cron-b");
  await invoice(a, { total: 25, status: "SENT" });
  await c.expenses.insertOne({ ...base(b), vendor: "V", amount: 5, currency: "USD", status: "APPROVED" });
  const r = await syncAllLedgers({ orgIds: [a.id, b.id] });
  assert.deepEqual({ orgs: r.orgs, posted: r.posted, failedOrgs: r.failedOrgs }, { orgs: 2, posted: 2, failedOrgs: 0 });
  assert.equal((await syncAllLedgers({ orgIds: [a.id, b.id] })).posted, 0);
});
