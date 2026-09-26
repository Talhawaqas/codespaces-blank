// src/lib/bookkeeper/anomaly.js
//
// AI Bookkeeper SOW sections 18 and 36: a NON-AUTHORITATIVE anomaly layer. It never blocks or changes a record by itself and never claims
// fraud; it raises a flag whose wording is always "Potential anomaly detected: human review required." Signals are simple, explainable
// statistics over the organization's own history. Nothing here calls a model.

import { toObjectId } from "../orgs.js";
import { getBookkeeperCollections } from "./db.js";
import { cents, normVendor, daysBetween, round4 } from "./common.js";
import { counterpartyKey } from "./categorize.js";

const SEV = { low: 0.3, medium: 0.6, high: 0.9 };
const PREFIX = "Potential anomaly detected: ";
const flag = (code, severity, detail) => ({ code, severity, score: SEV[severity], detail: `${PREFIX}${detail} Human review required.` });
const SUSPICIOUS_WORDS = /\b(gift\s*card|crypto|bitcoin|western\s*union|moneygram|urgent\s+transfer|wire\s+immediately|lottery|prize|refund\s+overpayment)\b/i;

const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : 0; };
const stdev = (a) => { if (a.length < 2) return 0; const m = a.reduce((s, x) => s + x, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };

/** Pure: flags for one transaction given the same counterparty's recent history (excluding the transaction itself). */
export function anomaliesForTransaction({ txn, history = [], knownCounterparty = false, thresholds = {} }) {
  const flags = [];
  const same = history.filter((h) => h.direction === txn.direction);
  const amts = same.map((h) => h.amount);
  if (SUSPICIOUS_WORDS.test(`${txn.description} ${txn.counterparty || ""}`)) flags.push(flag("SUSPICIOUS_DESCRIPTION", "high", "the bank description contains wording often associated with scams."));
  const dup = same.find((h) => cents(h.amount) === cents(txn.amount) && h.currency === txn.currency && daysBetween(h.date, txn.date) <= 3 && String(h._id) !== String(txn._id));
  if (dup) flags.push(flag(txn.direction === "DEBIT" ? "DUPLICATE_PAYMENT" : "DUPLICATE_RECEIPT", "high", `a ${txn.currency} ${txn.amount.toFixed(2)} ${txn.direction === "DEBIT" ? "payment" : "receipt"} to/from the same party was already recorded within 3 days (${dup.date}).`));
  if (amts.length >= 5) {
    const med = median(amts); const sd = stdev(amts); const mean = amts.reduce((s, x) => s + x, 0) / amts.length;
    if (txn.amount > med * 10 && txn.amount > 100) flags.push(flag("UNUSUAL_AMOUNT", "high", `the amount is more than 10 times this counterparty's median of ${med.toFixed(2)}.`));
    else if (sd > 0 && txn.amount > mean + 3 * sd) flags.push(flag("UNUSUAL_AMOUNT", "medium", `the amount is more than three standard deviations above this counterparty's average of ${mean.toFixed(2)}.`));
  }
  if (!knownCounterparty && same.length === 0 && txn.direction === "DEBIT") flags.push(flag("NEW_COUNTERPARTY", txn.amount >= (thresholds.newVendorAmount ?? 1000) ? "medium" : "low", "this is the first payment to a counterparty that is not a known supplier."));
  if (same.length >= 3 && txn.amount >= 1000 && txn.amount % 1000 === 0 && same.filter((h) => h.amount % 1000 === 0).length >= 2) flags.push(flag("REPEATED_ROUND_AMOUNTS", "low", "several payments to this counterparty are exact round thousands."));
  const hist = history.filter((h) => h.currency && h.currency !== txn.currency);
  if (history.length >= 3 && hist.length === 0 && !history.some((h) => h.currency === txn.currency)) flags.push(flag("UNEXPECTED_CURRENCY", "medium", `earlier transactions with this counterparty were in ${history[0].currency}, this one is in ${txn.currency}.`));
  const day = same.filter((h) => h.date === txn.date && String(h._id) !== String(txn._id));
  if (day.length >= 2 && day.reduce((s, h) => s + h.amount, txn.amount) >= 1000 && txn.amount < day.reduce((s, h) => s + h.amount, txn.amount)) flags.push(flag("SPLIT_PAYMENTS", "medium", `${day.length + 1} payments to the same counterparty on ${txn.date} add up to ${day.reduce((s, h) => s + h.amount, txn.amount).toFixed(2)}.`));
  const recent = same.filter((h) => daysBetween(h.date, txn.date) <= 7 && String(h._id) !== String(txn._id)).length; const older = same.filter((h) => daysBetween(h.date, txn.date) > 7).length;
  if (recent >= 4 && older <= 1) flags.push(flag("SUDDEN_ACTIVITY", "medium", `${recent} transactions with this counterparty in the past week, after almost none before.`));
  return { flags, score: round4(flags.reduce((m, f) => Math.max(m, f.score), 0)) };
}

/** Loads the counterparty's history and evaluates a stored bank transaction. */
export async function checkTransaction({ orgId, txn }) {
  const { bkTransactions, suppliers } = await getBookkeeperCollections(); const oid = toObjectId(orgId);
  const key = txn.counterpartyKey || counterpartyKey(txn);
  const history = key ? await bkTransactions.find({ orgId: oid, counterpartyKey: key, _id: { $ne: txn._id } }).sort({ date: -1 }).limit(200).project({ amount: 1, currency: 1, date: 1, direction: 1 }).toArray() : [];
  const sup = await suppliers.find({ orgId: oid, deletedAt: null }).project({ name: 1 }).limit(2000).toArray();
  const cp = normVendor(txn.counterparty || key || "");
  const knownCounterparty = !!cp && sup.some((s) => { const n = normVendor(s.name); return n && (n === cp || n.includes(cp) || cp.includes(n)); });
  return anomaliesForTransaction({ txn, history, knownCounterparty });
}
