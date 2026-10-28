// src/lib/ledger.js
//
// Business Workspace gap closure, Batch 2 — a double-entry general ledger.
//
// Entries are never edited; a correction is a reversing entry. Every entry
// must balance (Σdebit = Σcredit > 0), checked in integer cents.
//
// Automatic posting is STATE-DERIVED: syncLedger() reads the current
// invoices, expenses and payments and posts whatever entry is missing,
// keyed by a unique (orgId, source.type, source.id, source.event) index.
// That catches every way a record can change (UI, the AI-action executor,
// the AI Bookkeeper, cron) without modifying any workflow library, and a
// repeated or concurrent sync can never double-post.
//
// Posting rules:
//   invoice SENT/OVERDUE/PAID      Dr Accounts Receivable / Cr Sales Revenue
//   invoice PAID                   Dr Cash / Cr Accounts Receivable
//   invoice CANCELLED after posted Dr Sales Revenue / Cr Accounts Receivable
//   expense APPROVED               Dr Operating Expenses / Cr Accounts Payable
//   payment APPROVED
//     OUTGOING for an expense      Dr Accounts Payable / Cr Cash
//     INCOMING for an invoice      not posted — the invoice's PAID event
//                                  already moved the cash (no double count)
//     INCOMING, unlinked           Dr Cash / Cr Other Income
//     OUTGOING, otherwise          Dr Other Expenses / Cr Cash
// The ledger is kept in USD. A non-USD amount is converted at the daily
// rate stored for the entry's date (fx-rates.js), or the static dated
// reference table (currency.js) when no daily rate exists; each line keeps
// the original amount, currency, rate, ratesAsOf and fxSource. An
// unsupported currency is reported, never guessed.
//
// Industry billing that lives outside `invoices` is posted the same way
// (health patient invoices already use `invoices`):
//   legal bill SENT/OVERDUE/PAID   Dr Accounts Receivable / Cr Sales Revenue
//   legal bill PAID                Dr Cash / Cr Accounts Receivable
//   legal bill CANCELLED after posted  reverses the first
//   school fee invoice issued      Dr Accounts Receivable / Cr Fee Income
//   late fee added                 Dr Accounts Receivable / Cr Fee Income
//   fee invoice cancelled          reverses whatever of the two was posted
//   fee payment recorded           Dr Cash / Cr Accounts Receivable (on paidOn)
//   fee payment reversed           Dr Accounts Receivable / Cr Cash
// Fee amounts are integer minor units (2-decimal currencies). Memos carry
// invoice and receipt numbers only, never a student's name, so erasing a
// student leaves nothing personal in the ledger. Fund capital events
// (Financial OS) and legal trust money are NOT posted: they belong to the
// fund or the client, not to the organization's own books.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { logOrgActivity } from "./org-activity-log.js";
import { convertAt } from "./fx-rates.js";

export const ACCOUNT_TYPES = ["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"];
const DEBIT_NORMAL = new Set(["ASSET", "EXPENSE"]);

export const ACCOUNTS = {
  CASH: "1000", AR: "1100", AP: "2000", EQUITY: "3000",
  SALES: "4000", OTHER_INCOME: "4900", OPEX: "5000", OTHER_EXPENSE: "5900",
  FEES: "4100",
};
// Created only for organizations that bill school fees (syncLedger).
const FEE_INCOME_ACCOUNT = { code: ACCOUNTS.FEES, name: "Fee Income", type: "REVENUE" };
export const DEFAULT_ACCOUNTS = [
  { code: ACCOUNTS.CASH, name: "Cash", type: "ASSET" },
  { code: ACCOUNTS.AR, name: "Accounts Receivable", type: "ASSET" },
  { code: ACCOUNTS.AP, name: "Accounts Payable", type: "LIABILITY" },
  { code: ACCOUNTS.EQUITY, name: "Owner's Equity", type: "EQUITY" },
  { code: ACCOUNTS.SALES, name: "Sales Revenue", type: "REVENUE" },
  { code: ACCOUNTS.OTHER_INCOME, name: "Other Income", type: "REVENUE" },
  { code: ACCOUNTS.OPEX, name: "Operating Expenses", type: "EXPENSE" },
  { code: ACCOUNTS.OTHER_EXPENSE, name: "Other Expenses", type: "EXPENSE" },
];

const toCents = (n) => Math.round(Number(n) * 100);
const fromCents = (c) => c / 100;
const dateOnly = (d) => String(d || "").slice(0, 10);

export async function ensureChartOfAccounts(orgId) {
  const { ledgerAccounts } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const now = new Date().toISOString();
  await Promise.all(DEFAULT_ACCOUNTS.map((a) => ledgerAccounts.updateOne(
    { orgId: orgObjectId, code: a.code },
    { $setOnInsert: { orgId: orgObjectId, ...a, system: true, createdAt: now } },
    { upsert: true }
  ).catch((err) => { if (err?.code !== 11000) throw err; })));
}

export async function listAccounts(orgId) {
  const { ledgerAccounts } = await getOrgCollections();
  await ensureChartOfAccounts(orgId);
  return ledgerAccounts.find({ orgId: toObjectId(orgId) }).sort({ code: 1 }).toArray();
}

export async function createAccount({ orgId, code, name, type, actorEmail }) {
  const cleanCode = String(code || "").trim();
  const cleanName = String(name || "").trim();
  if (!/^\d{3,6}$/.test(cleanCode)) return { error: "Account code must be 3 to 6 digits.", status: 400 };
  if (!cleanName) return { error: "Account name is required.", status: 400 };
  if (!ACCOUNT_TYPES.includes(type)) return { error: `Account type must be one of ${ACCOUNT_TYPES.join(", ")}.`, status: 400 };
  const { ledgerAccounts } = await getOrgCollections();
  await ensureChartOfAccounts(orgId);
  const doc = { orgId: toObjectId(orgId), code: cleanCode, name: cleanName, type, system: false, createdByEmail: actorEmail, createdAt: new Date().toISOString() };
  try {
    const r = await ledgerAccounts.insertOne(doc);
    return { account: { ...doc, _id: r.insertedId } };
  } catch (err) {
    if (err?.code === 11000) return { error: `Account ${cleanCode} already exists.`, status: 409 };
    throw err;
  }
}

/** Validates journal lines against the chart of accounts. Returns
 *  { lines } with amounts rounded to cents, or { error }. */
export function validateLines(lines, accountCodes) {
  if (!Array.isArray(lines) || lines.length < 2) return { error: "An entry needs at least two lines." };
  let debit = 0;
  let credit = 0;
  const clean = [];
  for (const raw of lines) {
    const accountCode = String(raw?.accountCode || "").trim();
    if (!accountCodes.has(accountCode)) return { error: `Unknown account "${accountCode}".` };
    const d = toCents(raw?.debit || 0);
    const c = toCents(raw?.credit || 0);
    if (!Number.isFinite(d) || !Number.isFinite(c) || d < 0 || c < 0) return { error: "Amounts must be zero or more." };
    if ((d > 0) === (c > 0)) return { error: "Each line needs either a debit or a credit, not both." };
    debit += d;
    credit += c;
    const line = { accountCode, debit: fromCents(d), credit: fromCents(c) };
    for (const k of ["memo", "originalAmount", "originalCurrency", "fxRate", "ratesAsOf", "fxSource"]) if (raw[k] !== undefined && raw[k] !== null) line[k] = raw[k];
    clean.push(line);
  }
  if (debit !== credit) return { error: `Entry doesn't balance: debits ${fromCents(debit).toFixed(2)} vs credits ${fromCents(credit).toFixed(2)}.` };
  return { lines: clean, total: fromCents(debit) };
}

/** Posts a balanced entry. With a `source`, posting is idempotent: a second
 *  attempt returns the existing entry with created:false. */
export async function postEntry({ orgId, date, memo, lines, source = null, reversalOf = null, actorEmail }) {
  const { journalEntries } = await getOrgCollections();
  const accounts = await listAccounts(orgId);
  const checked = validateLines(lines, new Set(accounts.map((a) => a.code)));
  if (checked.error) return { error: checked.error, status: 400 };
  const entryDate = dateOnly(date) || dateOnly(new Date().toISOString());
  if (Number.isNaN(new Date(entryDate).getTime())) return { error: "Invalid entry date.", status: 400 };
  const orgObjectId = toObjectId(orgId);
  const doc = {
    orgId: orgObjectId, date: entryDate, memo: String(memo || "").trim() || null,
    lines: checked.lines, total: checked.total,
    ...(source ? { source } : {}), ...(reversalOf ? { reversalOf } : {}),
    postedByEmail: actorEmail, createdAt: new Date().toISOString(),
  };
  try {
    const r = await journalEntries.insertOne(doc);
    await logOrgActivity({
      orgId: orgObjectId, recordType: "JOURNAL_ENTRY", recordId: r.insertedId, actorEmail,
      action: reversalOf ? "JOURNAL_ENTRY_REVERSED" : "JOURNAL_ENTRY_POSTED", previousState: null, newState: null,
      metadata: { total: checked.total, source: source || null },
    });
    return { entry: { ...doc, _id: r.insertedId }, created: true };
  } catch (err) {
    if (err?.code !== 11000 || !source) throw err;
    const existing = await journalEntries.findOne({ orgId: orgObjectId, "source.type": source.type, "source.id": source.id, "source.event": source.event });
    return { entry: existing, created: false };
  }
}

/** Reverses an entry once (a second reversal returns the first). */
export async function reverseEntry({ orgId, entryId, date, actorEmail }) {
  const { journalEntries } = await getOrgCollections();
  const original = await journalEntries.findOne({ _id: toObjectId(entryId), orgId: toObjectId(orgId) });
  if (!original) return { error: "Journal entry not found.", status: 404 };
  if (original.reversalOf) return { error: "A reversing entry can't itself be reversed.", status: 409 };
  return postEntry({
    orgId, date: date || new Date().toISOString(), memo: `Reversal of: ${original.memo || original._id}`,
    lines: original.lines.map((l) => ({ ...l, debit: l.credit, credit: l.debit })),
    source: { type: "REVERSAL", id: original._id.toString(), event: "REVERSE" }, reversalOf: original._id, actorEmail,
  });
}

// Returns a builder resolved at posting time, so a non-USD amount converts
// at the daily rate stored for the entry's own date (fx-rates.js), falling
// back to the static reference table. Posted entries keep the rate they
// were posted with.
function usdLines(amount, currency, debitCode, creditCode, memo) {
  return async (date) => {
    const cur = String(currency || "USD").toUpperCase();
    let usd = amount;
    const extra = {};
    if (cur !== "USD") {
      const c = await convertAt(Number(amount), cur, "USD", date ? String(date).slice(0, 10) : undefined);
      if (c.error) return { error: c.error };
      usd = c.convertedAmount;
      Object.assign(extra, { originalAmount: amount, originalCurrency: cur, fxRate: c.rate, ratesAsOf: c.ratesAsOf, fxSource: c.source });
    }
    return { lines: [
      { accountCode: debitCode, debit: usd, credit: 0, memo, ...extra },
      { accountCode: creditCode, debit: 0, credit: usd, memo, ...extra },
    ] };
  };
}

/** Posts every missing automatic entry for an org. Safe to call any time,
 *  as often as wanted. Returns { posted, skipped, errors }. */
export async function syncLedger(orgId, { actorEmail = "system:ledger" } = {}) {
  const { invoices, expenses, payments, legalBilling, eduFeeInvoices, eduFeePayments, ledgerAccounts, journalEntries, orgActivity } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  await ensureChartOfAccounts(orgId);

  const [invList, expList, payList, legalList, feeInvList, feePayList] = await Promise.all([
    invoices.find({ orgId: orgObjectId, deletedAt: null, status: { $in: ["SENT", "OVERDUE", "PAID", "CANCELLED"] } }).toArray(),
    expenses.find({ orgId: orgObjectId, deletedAt: null, status: "APPROVED" }).toArray(),
    payments.find({ orgId: orgObjectId, deletedAt: null, status: "APPROVED" }).toArray(),
    legalBilling.find({ orgId: orgObjectId, status: { $in: ["SENT", "OVERDUE", "PAID", "CANCELLED"] } }).toArray(),
    eduFeeInvoices.find({ orgId: orgObjectId }).toArray(),
    eduFeePayments.find({ orgId: orgObjectId }).toArray(),
  ]);
  if (feeInvList.length || feePayList.length) {
    await ledgerAccounts.updateOne(
      { orgId: orgObjectId, code: FEE_INCOME_ACCOUNT.code },
      { $setOnInsert: { orgId: orgObjectId, ...FEE_INCOME_ACCOUNT, system: true, createdAt: new Date().toISOString() } },
      { upsert: true }
    ).catch((err) => { if (err?.code !== 11000) throw err; });
  }
  const posted = new Set((await journalEntries.find(
    { orgId: orgObjectId, "source.type": { $in: ["INVOICE", "EXPENSE", "PAYMENT", "LEGAL_BILL", "EDU_FEE_INVOICE", "EDU_FEE_PAYMENT"] } },
    { projection: { source: 1 } }
  ).toArray()).map((e) => `${e.source.type}:${e.source.id}:${e.source.event}`));

  const ids = [...invList, ...expList, ...payList, ...legalList].map((d) => d._id);
  const eventTimes = new Map();
  if (ids.length) {
    const events = await orgActivity.find(
      { orgId: orgObjectId, recordId: { $in: ids }, action: { $in: ["INVOICE_SENT", "INVOICE_PAID", "INVOICE_CANCELLED", "EXPENSE_APPROVED", "PAYMENT_APPROVED", "SENT", "PAID", "CANCELLED"] } },
      { projection: { recordId: 1, action: 1, timestamp: 1 } }
    ).toArray();
    for (const e of events) {
      const key = `${e.recordId}:${e.action}`;
      if (!eventTimes.has(key) || e.timestamp < eventTimes.get(key)) eventTimes.set(key, e.timestamp);
    }
  }
  const when = (doc, action, fallback) => eventTimes.get(`${doc._id}:${action}`) || fallback || doc.updatedAt || doc.createdAt;

  const plan = [];
  const add = (type, doc, event, date, memo, built) => {
    if (posted.has(`${type}:${doc._id}:${event}`)) return;
    plan.push({ type, doc, event, date, memo, built });
  };
  for (const inv of invList) {
    const label = `Invoice ${inv.invoiceNumber || inv._id}`;
    const amount = Number(inv.total) || 0;
    if (amount <= 0) continue;
    const sentKey = `INVOICE:${inv._id}:SENT`;
    if (["SENT", "OVERDUE", "PAID"].includes(inv.status)) {
      add("INVOICE", inv, "SENT", when(inv, "INVOICE_SENT", inv.issueDate), `${label} issued`, usdLines(amount, inv.currency, ACCOUNTS.AR, ACCOUNTS.SALES, label));
    }
    if (inv.status === "PAID") {
      add("INVOICE", inv, "PAID", when(inv, "INVOICE_PAID", inv.updatedAt), `${label} paid`, usdLines(amount, inv.currency, ACCOUNTS.CASH, ACCOUNTS.AR, label));
    }
    if (inv.status === "CANCELLED" && posted.has(sentKey)) {
      add("INVOICE", inv, "CANCELLED", when(inv, "INVOICE_CANCELLED", inv.updatedAt), `${label} cancelled`, usdLines(amount, inv.currency, ACCOUNTS.SALES, ACCOUNTS.AR, label));
    }
  }
  for (const exp of expList) {
    const amount = Number(exp.amount) || 0;
    if (amount <= 0) continue;
    const memo = `${exp.vendor || "Expense"}${exp.category ? ` (${exp.category})` : ""}`;
    add("EXPENSE", exp, "APPROVED", when(exp, "EXPENSE_APPROVED", exp.expenseDate), memo, usdLines(amount, exp.currency, ACCOUNTS.OPEX, ACCOUNTS.AP, memo));
  }
  for (const pay of payList) {
    const amount = Number(pay.amount) || 0;
    if (amount <= 0) continue;
    if (pay.direction === "INCOMING" && pay.relatedInvoiceId) continue;
    let debit, credit, memo;
    if (pay.direction === "OUTGOING" && pay.relatedExpenseId) { debit = ACCOUNTS.AP; credit = ACCOUNTS.CASH; memo = "Expense payment"; }
    else if (pay.direction === "INCOMING") { debit = ACCOUNTS.CASH; credit = ACCOUNTS.OTHER_INCOME; memo = "Incoming payment"; }
    else { debit = ACCOUNTS.OTHER_EXPENSE; credit = ACCOUNTS.CASH; memo = pay.relatedPurchaseOrderId ? "Purchase order payment" : "Outgoing payment"; }
    add("PAYMENT", pay, "APPROVED", when(pay, "PAYMENT_APPROVED", pay.paymentDate), memo, usdLines(amount, pay.currency, debit, credit, memo));
  }

  for (const bill of legalList) {
    const label = `Legal bill ${bill.invoiceNumber || bill._id}`;
    const amount = Number(bill.total) || 0;
    if (amount <= 0) continue;
    if (["SENT", "OVERDUE", "PAID"].includes(bill.status)) {
      add("LEGAL_BILL", bill, "SENT", when(bill, "SENT", bill.createdAt), `${label} issued`, usdLines(amount, bill.currency, ACCOUNTS.AR, ACCOUNTS.SALES, label));
    }
    if (bill.status === "PAID") {
      add("LEGAL_BILL", bill, "PAID", when(bill, "PAID", bill.updatedAt), `${label} paid`, usdLines(amount, bill.currency, ACCOUNTS.CASH, ACCOUNTS.AR, label));
    }
    if (bill.status === "CANCELLED" && posted.has(`LEGAL_BILL:${bill._id}:SENT`)) {
      add("LEGAL_BILL", bill, "CANCELLED", when(bill, "CANCELLED", bill.updatedAt), `${label} cancelled`, usdLines(amount, bill.currency, ACCOUNTS.SALES, ACCOUNTS.AR, label));
    }
  }
  for (const inv of feeInvList) {
    const label = `Fee invoice ${inv.invoiceNo || inv._id}`;
    const late = Number(inv.lateFeeMinor) || 0;
    const base = (Number(inv.totalMinor) || 0) - late;
    if (inv.status !== "cancelled") {
      if (base > 0) add("EDU_FEE_INVOICE", inv, "ISSUED", inv.issuedAt, `${label} issued`, usdLines(fromCents(base), inv.currency, ACCOUNTS.AR, ACCOUNTS.FEES, label));
      if (late > 0) add("EDU_FEE_INVOICE", inv, "LATE_FEE", inv.lateFeeAppliedAt || inv.issuedAt, `${label} late fee`, usdLines(fromCents(late), inv.currency, ACCOUNTS.AR, ACCOUNTS.FEES, `${label} late fee`));
    } else {
      if (base > 0 && posted.has(`EDU_FEE_INVOICE:${inv._id}:ISSUED`)) add("EDU_FEE_INVOICE", inv, "CANCELLED", inv.cancelledAt, `${label} cancelled`, usdLines(fromCents(base), inv.currency, ACCOUNTS.FEES, ACCOUNTS.AR, label));
      if (late > 0 && posted.has(`EDU_FEE_INVOICE:${inv._id}:LATE_FEE`)) add("EDU_FEE_INVOICE", inv, "LATE_FEE_CANCELLED", inv.cancelledAt, `${label} late fee cancelled`, usdLines(fromCents(late), inv.currency, ACCOUNTS.FEES, ACCOUNTS.AR, `${label} late fee`));
    }
  }
  for (const pay of feePayList) {
    const label = `Fee receipt ${pay.receiptNo || pay._id}`;
    const amount = fromCents(Number(pay.amountMinor) || 0);
    if (amount <= 0) continue;
    add("EDU_FEE_PAYMENT", pay, "RECEIVED", pay.paidOn || pay.recordedAt, label, usdLines(amount, pay.currency, ACCOUNTS.CASH, ACCOUNTS.AR, label));
    if (pay.status === "reversed") {
      add("EDU_FEE_PAYMENT", pay, "REVERSED", pay.reversedAt, `${label} reversed`, usdLines(amount, pay.currency, ACCOUNTS.AR, ACCOUNTS.CASH, `${label} reversed`));
    }
  }

  let count = 0;
  const errors = [];
  for (const p of plan) {
    const built = await p.built(p.date);
    if (built.error) { errors.push({ source: `${p.type}:${p.doc._id}:${p.event}`, error: built.error }); continue; }
    const result = await postEntry({
      orgId, date: p.date, memo: p.memo, lines: built.lines, actorEmail,
      source: { type: p.type, id: p.doc._id.toString(), event: p.event },
    });
    if (result.error) errors.push({ source: `${p.type}:${p.doc._id}:${p.event}`, error: result.error });
    else if (result.created) count++;
  }
  return { posted: count, skipped: plan.length - count - errors.length, errors };
}

/** Daily cron: sync every org that has finance records. One org failing
 *  never stops the others. `orgIds` scopes a run (tests). */
export async function syncAllLedgers({ orgIds } = {}) {
  const { invoices, expenses, payments, legalBilling, eduFeeInvoices, eduFeePayments } = await getOrgCollections();
  const scope = orgIds ? { orgId: { $in: orgIds.map(toObjectId) } } : {};
  const all = await Promise.all([invoices, expenses, payments, legalBilling, eduFeeInvoices, eduFeePayments].map((c) => c.distinct("orgId", { ...scope, deletedAt: null })));
  const unique = [...new Map(all.flat().filter(Boolean).map((id) => [id.toString(), id])).keys()];
  const out = { orgs: unique.length, posted: 0, failedOrgs: 0, errors: 0 };
  for (const id of unique) {
    try {
      const r = await syncLedger(id);
      out.posted += r.posted; out.errors += r.errors.length;
    } catch (err) {
      out.failedOrgs++;
      console.error(`syncLedger failed for org ${id}:`, err.message);
    }
  }
  return out;
}

export async function listEntries(orgId, { from, to, limit = 200 } = {}) {
  const { journalEntries } = await getOrgCollections();
  const q = { orgId: toObjectId(orgId) };
  if (from || to) q.date = { ...(from ? { $gte: dateOnly(from) } : {}), ...(to ? { $lte: dateOnly(to) } : {}) };
  return journalEntries.find(q).sort({ date: -1, createdAt: -1 }).limit(Math.min(limit, 1000)).toArray();
}

/** Per-account debit/credit totals (in cents) for entries dated within [from, to]. */
async function accountTotals(orgId, { from, to } = {}) {
  const { journalEntries } = await getOrgCollections();
  const match = { orgId: toObjectId(orgId) };
  if (from || to) match.date = { ...(from ? { $gte: dateOnly(from) } : {}), ...(to ? { $lte: dateOnly(to) } : {}) };
  const rows = await journalEntries.aggregate([
    { $match: match }, { $unwind: "$lines" },
    { $group: { _id: "$lines.accountCode", debit: { $sum: "$lines.debit" }, credit: { $sum: "$lines.credit" } } },
  ]).toArray();
  return new Map(rows.map((r) => [r._id, { debit: toCents(r.debit), credit: toCents(r.credit) }]));
}

function natural(type, t) {
  return DEBIT_NORMAL.has(type) ? t.debit - t.credit : t.credit - t.debit;
}

export async function trialBalance(orgId, { asOf } = {}) {
  const accounts = await listAccounts(orgId);
  const totals = await accountTotals(orgId, { to: asOf });
  let debit = 0;
  let credit = 0;
  const rows = accounts.map((a) => {
    const t = totals.get(a.code) || { debit: 0, credit: 0 };
    const net = t.debit - t.credit;
    const row = { code: a.code, name: a.name, type: a.type, debit: net > 0 ? fromCents(net) : 0, credit: net < 0 ? fromCents(-net) : 0 };
    debit += Math.max(net, 0);
    credit += Math.max(-net, 0);
    return row;
  }).filter((r) => r.debit || r.credit);
  return { asOf: asOf ? dateOnly(asOf) : null, rows, totalDebit: fromCents(debit), totalCredit: fromCents(credit), balanced: debit === credit };
}

export async function profitAndLoss(orgId, { from, to } = {}) {
  const accounts = await listAccounts(orgId);
  const totals = await accountTotals(orgId, { from, to });
  const section = (type) => accounts.filter((a) => a.type === type)
    .map((a) => ({ code: a.code, name: a.name, amount: natural(a.type, totals.get(a.code) || { debit: 0, credit: 0 }) }))
    .filter((r) => r.amount !== 0);
  const revenue = section("REVENUE");
  const expenses = section("EXPENSE");
  const rev = revenue.reduce((s, r) => s + r.amount, 0);
  const exp = expenses.reduce((s, r) => s + r.amount, 0);
  const out = (list) => list.map((r) => ({ ...r, amount: fromCents(r.amount) }));
  return { from: from ? dateOnly(from) : null, to: to ? dateOnly(to) : null, revenue: out(revenue), expenses: out(expenses), totalRevenue: fromCents(rev), totalExpenses: fromCents(exp), netIncome: fromCents(rev - exp) };
}

export async function balanceSheet(orgId, { asOf } = {}) {
  const accounts = await listAccounts(orgId);
  const totals = await accountTotals(orgId, { to: asOf });
  const section = (type) => accounts.filter((a) => a.type === type)
    .map((a) => ({ code: a.code, name: a.name, amount: natural(a.type, totals.get(a.code) || { debit: 0, credit: 0 }) }))
    .filter((r) => r.amount !== 0);
  const sum = (list) => list.reduce((s, r) => s + r.amount, 0);
  const assets = section("ASSET");
  const liabilities = section("LIABILITY");
  const equity = section("EQUITY");
  // Revenue minus expenses to date isn't closed into equity by a period-end
  // entry here, so it's shown as retained earnings to keep A = L + E.
  const retained = sum(section("REVENUE")) - sum(section("EXPENSE"));
  const totalAssets = sum(assets);
  const totalLE = sum(liabilities) + sum(equity) + retained;
  const out = (list) => list.map((r) => ({ ...r, amount: fromCents(r.amount) }));
  return {
    asOf: asOf ? dateOnly(asOf) : null, assets: out(assets), liabilities: out(liabilities), equity: out(equity),
    retainedEarnings: fromCents(retained), totalAssets: fromCents(totalAssets), totalLiabilitiesAndEquity: fromCents(totalLE),
    balanced: totalAssets === totalLE,
  };
}
