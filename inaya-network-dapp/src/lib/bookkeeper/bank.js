// src/lib/bookkeeper/bank.js
//
// AI Bookkeeper SOW section 7: provider-neutral bank transactions. What is REAL here: CSV and OFX/QFX statement import, duplicate-safe and
// idempotent, with a full audit and evidence trail. What is NOT here: a live bank feed. `PROVIDER_ADAPTERS` is the interface a real provider
// (Plaid, an open-banking aggregator, a bank API) would implement; none is registered, so none is claimed. Never store bank credentials.

import { toObjectId } from "../orgs.js";
import { getBookkeeperCollections, ensureBookkeeperIndexes } from "./db.js";
import { fail, nowIso, sha256, parseAmount, parseDate, normText, SUPPORTED_CURRENCIES } from "./common.js";
import { audit, event, link } from "./record.js";
import { counterpartyKey } from "./categorize.js";

export const MAX_STATEMENT_BYTES = 5 * 1024 * 1024;
export const MAX_ROWS = 20000;

/** A real provider registers { id, sync({ connection, since }) -> { transactions[] } } here. Empty on purpose: no provider has been verified. */
export const PROVIDER_ADAPTERS = {};

// ------------------------------------------------------------------------------------------------------------------ CSV
export function parseCsv(text, delimiter = null) {
  const src = String(text).replace(/^﻿/, "");
  const first = src.split(/\r?\n/, 1)[0] || "";
  const d = delimiter || [",", ";", "\t", "|"].map((c) => [c, first.split(c).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = []; let cell = ""; let q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) { if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === d) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && src[i + 1] === "\n") i++; row.push(cell); cell = ""; if (row.some((c) => c.trim() !== "")) rows.push(row); row = []; }
    else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); if (row.some((c) => c.trim() !== "")) rows.push(row); }
  return { rows, delimiter: d };
}

const HEADERS = {
  date: ["date", "transaction date", "posting date", "posted date", "booking date", "trans date", "value date", "txn date"],
  valueDate: ["value date", "effective date"],
  description: ["description", "details", "narrative", "memo", "transaction description", "particulars", "remarks", "payee description"],
  counterparty: ["payee", "counterparty", "beneficiary", "name", "merchant", "party"],
  amount: ["amount", "value", "transaction amount", "amt"],
  debit: ["debit", "withdrawal", "withdrawals", "paid out", "money out", "dr"],
  credit: ["credit", "deposit", "deposits", "paid in", "money in", "cr"],
  currency: ["currency", "ccy", "curr"],
  reference: ["reference", "ref", "reference number", "check number", "cheque number", "payment reference", "invoice"],
  balance: ["balance", "running balance", "closing balance"],
  externalId: ["transaction id", "id", "fitid", "unique id", "txn id", "transaction reference"],
};

export function detectColumns(header) {
  const norm = header.map((h) => normText(h)); const map = {};
  for (const [field, names] of Object.entries(HEADERS)) { const i = norm.findIndex((h) => names.includes(h)); if (i > -1 && !Object.values(map).includes(i)) map[field] = i; }
  return map;
}

/** Normalizes one bank line. direction CREDIT = money in, DEBIT = money out; amount is always positive. */
function makeTxn(f, opts) {
  const date = parseDate(f.date, { dayFirst: opts.dayFirst });
  if (!date) return { error: `Unrecognized date "${f.date}".` };
  let signed = NaN;
  if (f.amount !== undefined && f.amount !== "") signed = parseAmount(f.amount);
  else { const cr = parseAmount(f.credit), dr = parseAmount(f.debit); if (Number.isFinite(cr) && cr !== 0) signed = Math.abs(cr); else if (Number.isFinite(dr) && dr !== 0) signed = -Math.abs(dr); }
  if (!Number.isFinite(signed) || signed === 0) return { error: "No usable amount." };
  const currency = String(f.currency || opts.currency || "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return { error: "Currency is missing (set the account currency on the source)." };
  const description = String(f.description || f.counterparty || "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (!description) return { error: "No description." };
  return { txn: { externalId: f.externalId ? String(f.externalId).trim().slice(0, 100) : null, date, valueDate: parseDate(f.valueDate, { dayFirst: opts.dayFirst }) || null, description, counterparty: f.counterparty ? String(f.counterparty).trim().slice(0, 160) : null, amount: Math.abs(signed), direction: signed > 0 ? "CREDIT" : "DEBIT", currency, reference: f.reference ? String(f.reference).trim().slice(0, 100) : null, balance: Number.isFinite(parseAmount(f.balance)) ? parseAmount(f.balance) : null } };
}

export function parseStatementCsv(text, { mapping = null, dayFirst = true, currency = null, delimiter = null } = {}) {
  const { rows } = parseCsv(text, delimiter);
  if (rows.length < 2) return { error: "The CSV has no data rows." };
  const cols = mapping || detectColumns(rows[0]);
  if (cols.date === undefined || (cols.amount === undefined && cols.debit === undefined && cols.credit === undefined) || (cols.description === undefined && cols.counterparty === undefined)) return { error: "Could not find the date, amount and description columns. Send an explicit column mapping.", columns: rows[0] };
  const txns = []; const invalid = [];
  rows.slice(1, MAX_ROWS + 1).forEach((r, i) => {
    const f = {}; for (const [field, idx] of Object.entries(cols)) f[field] = r[idx];
    const res = makeTxn(f, { dayFirst, currency }); if (res.error) invalid.push({ row: i + 2, reason: res.error }); else txns.push(res.txn);
  });
  if (rows.length - 1 > MAX_ROWS) invalid.push({ row: MAX_ROWS + 2, reason: `Only the first ${MAX_ROWS} rows are imported per file.` });
  return { transactions: txns, invalid, columns: cols };
}

// ------------------------------------------------------------------------------------------------------------------ OFX / QFX
const tag = (block, name) => { const m = new RegExp(`<${name}>([^<\\r\\n]*)`, "i").exec(block); return m ? m[1].trim() : null; };
export function parseStatementOfx(text, { currency = null } = {}) {
  const src = String(text);
  if (!/<OFX>/i.test(src) && !/<STMTTRN>/i.test(src)) return { error: "This does not look like an OFX file." };
  const cur = (tag(src, "CURDEF") || currency || "").toUpperCase();
  const accountId = tag(src, "ACCTID");
  const blocks = src.split(/<STMTTRN>/i).slice(1).map((b) => b.split(/<\/STMTTRN>/i)[0]);
  const txns = []; const invalid = [];
  blocks.slice(0, MAX_ROWS).forEach((b, i) => {
    const name = tag(b, "NAME"), memo = tag(b, "MEMO");
    const res = makeTxn({ date: tag(b, "DTPOSTED"), amount: tag(b, "TRNAMT"), externalId: tag(b, "FITID"), description: [name, memo].filter(Boolean).join(" - "), counterparty: name, reference: tag(b, "CHECKNUM") || tag(b, "REFNUM"), currency: cur }, { dayFirst: true, currency: cur });
    if (res.error) invalid.push({ row: i + 1, reason: res.error }); else txns.push(res.txn);
  });
  const bal = tag(src, "BALAMT");
  return { transactions: txns, invalid, accountId, currency: cur, closingBalance: bal ? parseAmount(bal) : null };
}

// ------------------------------------------------------------------------------------------------------------------ import
export const txnFingerprint = ({ orgId, accountId, t, occurrence = 0 }) => sha256([orgId, accountId, t.date, t.direction, Math.round(t.amount * 100), t.currency, normText(t.description), t.reference || "", t.externalId || "", occurrence].join("|"));

/**
 * Imports parsed transactions for one bank source. Idempotent: a re-import of the same file, or of an overlapping range, creates nothing
 * that already exists (external id, or a content fingerprint that counts identical rows within one file so genuine repeats survive).
 */
export async function importTransactions({ orgId, source, transactions, actor, batchId = null }) {
  await ensureBookkeeperIndexes();
  const { bkTransactions } = await getBookkeeperCollections();
  const oid = toObjectId(orgId); const now = nowIso();
  const seen = new Map(); let imported = 0; let duplicates = 0; const ids = [];
  for (const t of transactions) {
    if (!SUPPORTED_CURRENCIES.includes(t.currency) && !/^[A-Z]{3}$/.test(t.currency)) continue;
    const base = [t.date, t.direction, Math.round(t.amount * 100), t.currency, normText(t.description), t.reference || "", t.externalId || ""].join("|");
    const occurrence = seen.get(base) || 0; seen.set(base, occurrence + 1);
    const fingerprint = txnFingerprint({ orgId: String(orgId), accountId: String(source._id), t, occurrence });
    const doc = { orgId: oid, departmentId: source.departmentId, sourceId: source._id, accountId: String(source._id), source: "BANK", provider: source.provider || "file", ...t, counterpartyKey: counterpartyKey(t), fingerprint, status: "UNMATCHED", category: null, categoryConfidence: null, categoryMethod: null, importBatch: batchId, createdAt: now, updatedAt: now, importedBy: actor };
    try { const r = await bkTransactions.insertOne(doc); imported++; ids.push(r.insertedId); }
    catch (err) { if (err?.code === 11000) duplicates++; else throw err; }
  }
  const { bkSources } = await getBookkeeperCollections();
  await bkSources.updateOne({ _id: source._id }, { $set: { lastSyncAt: now, lastSyncStatus: "OK", lastSyncError: null, lastSyncImported: imported } });
  await audit({ orgId, recordId: source._id, action: "TRANSACTION_IMPORTED", actorEmail: actor, metadata: { sourceId: String(source._id), imported, duplicates, batchId } });
  for (const id of ids) link({ orgId, subjectType: "BOOKKEEPING_TRANSACTION", subjectId: id, type: "SOURCED_FROM", targetType: "BK_SOURCE", targetId: source._id, note: `imported from ${source.name}` });
  return { imported, duplicates, ids };
}

/** Parses and imports a statement file for a bank source. format: csv | ofx (auto-detected from content when omitted). */
export async function importStatement({ orgId, source, text, format = null, mapping = null, dayFirst = true, actor }) {
  if (!source || source.type !== "BANK_ACCOUNT") return fail("Choose a bank account source.", 400);
  if (typeof text !== "string" || !text.trim()) return fail("The statement is empty.");
  if (Buffer.byteLength(text) > MAX_STATEMENT_BYTES) return fail(`Statements can be at most ${MAX_STATEMENT_BYTES / 1024 / 1024} MB.`, 413);
  const fmt = format || (/<OFX>|<STMTTRN>/i.test(text.slice(0, 5000)) ? "ofx" : "csv");
  const parsed = fmt === "ofx" ? parseStatementOfx(text, { currency: source.currency }) : parseStatementCsv(text, { mapping, dayFirst, currency: source.currency });
  if (parsed.error) return fail(parsed.error, 400, parsed.columns ? { columns: parsed.columns } : {});
  if (!parsed.transactions.length) return fail("No valid transactions were found.", 400, { invalid: parsed.invalid.slice(0, 20) });
  const r = await importTransactions({ orgId, source, transactions: parsed.transactions, actor, batchId: sha256(text).slice(0, 16) });
  return { format: fmt, parsed: parsed.transactions.length, imported: r.imported, duplicates: r.duplicates, invalid: parsed.invalid.slice(0, 50), invalidCount: parsed.invalid.length };
}

/** Runs a registered provider adapter for a source (none exist today; kept so a verified provider can be added without touching callers). */
export async function syncSource({ orgId, source, actor }) {
  const adapter = PROVIDER_ADAPTERS[source.provider];
  if (!adapter) return fail(`No bank-feed provider "${source.provider}" is available. Import a CSV or OFX statement instead.`, 501, { reasonCode: "PROVIDER_NOT_AVAILABLE" });
  const { bkSources } = await getBookkeeperCollections();
  try {
    const r = await adapter.sync({ connection: source, since: source.lastSyncAt || null });
    const out = await importTransactions({ orgId, source, transactions: r.transactions || [], actor });
    return { synced: true, ...out };
  } catch (err) {
    await bkSources.updateOne({ _id: source._id }, { $set: { lastSyncStatus: "FAILED", lastSyncError: String(err.message).slice(0, 200), lastSyncAttemptAt: nowIso() } });
    await event({ orgId, type: "RECONCILIATION_EXCEPTION", recordId: source._id, actorEmail: actor, metadata: { sourceId: String(source._id), failure: "bank sync failed" } });
    return fail("The bank sync failed. It will be retried.", 502);
  }
}
