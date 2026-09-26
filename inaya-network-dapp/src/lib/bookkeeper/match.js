// src/lib/bookkeeper/match.js
//
// AI Bookkeeper SOW sections 13, 14, 15.3, 16: matching bank transactions to bills, customer invoices and receipts, and three-way matching of
// purchase order + supplier invoice + goods received. DETERMINISTIC FIRST, in the SOW's order:
//   exact external reference -> exact invoice number -> exact amount + currency -> party -> date window -> purchase order -> history -> fuzzy.
// The confidence of a match is computed by named rules from named signals, so every score can be explained (SOW 21) and reproduced.
// A model may only add a lower-confidence SUGGESTION; it can never override a deterministic conflict.
//
// Direction: a DEBIT (money out) is matched to payables (supplier invoices, bills, receipts, approved expenses); a CREDIT (money in) is
// matched to receivables (customer invoices). Amounts are compared in the transaction's own currency; a different currency is converted with
// the platform's dated reference table, flagged, and capped so it can never auto-process.

import { toObjectId } from "../orgs.js";
import { getBookkeeperCollections } from "./db.js";
import { cents, fromCents, normInvoiceNo, normText, vendorSimilarity, comparableAmount, daysBetween, round4, clamp01 } from "./common.js";

/** A payable or receivable, normalized from an existing record. `open` is what is still unallocated. */
async function allocatedFor({ orgId, targetKind, targetId }) {
  const { bkMatches } = await getBookkeeperCollections();
  const rows = await bkMatches.find({ orgId: toObjectId(orgId), targetKind, targetId, status: { $in: ["SUGGESTED", "AUTO_MATCHED", "CONFIRMED", "RECONCILED"] }, allocation: { $gt: 0 } }).project({ allocation: 1, status: 1 }).toArray();
  return rows.filter((r) => r.status !== "SUGGESTED").reduce((s, r) => s + r.allocation, 0);
}

export async function loadCandidates({ orgId, txn }) {
  const c = await getBookkeeperCollections(); const oid = toObjectId(orgId); const out = [];
  const dept = txn.departmentId;
  if (txn.direction === "CREDIT") {
    const invs = await c.invoices.find({ orgId: oid, deletedAt: null, status: { $in: ["SENT", "OVERDUE", "PAID"] } }).sort({ issueDate: -1 }).limit(1500).toArray();
    const contacts = new Map((await c.crmContacts.find({ orgId: oid, _id: { $in: invs.map((i) => i.contactId).filter(Boolean) } }).project({ name: 1, company: 1, email: 1 }).toArray()).map((x) => [String(x._id), x]));
    for (const i of invs) {
      const ct = contacts.get(String(i.contactId)); const alloc = await allocatedFor({ orgId, targetKind: "INVOICE", targetId: String(i._id) });
      const total = Number(i.total); const open = i.status === "PAID" ? 0 : Math.max(0, fromCents(cents(total) - cents(alloc)));
      out.push({ kind: "INVOICE", id: String(i._id), party: ct?.company || ct?.name || "", number: i.invoiceNumber, total, open, currency: i.currency || "USD", date: String(i.issueDate || "").slice(0, 10), dueDate: i.dueDate ? String(i.dueDate).slice(0, 10) : null, poNumber: null, reference: null, departmentId: i.departmentId, status: i.status, alreadyPaid: i.status === "PAID" });
    }
    const docs = await c.bkDocuments.find({ orgId: oid, documentType: "CUSTOMER_INVOICE", status: { $in: ["EXTRACTED", "NEEDS_REVIEW", "PROCESSED"] } }).limit(1500).toArray();
    for (const d of docs) { const total = d.fields?.total?.value; if (!(total > 0)) continue; const alloc = await allocatedFor({ orgId, targetKind: "BK_DOCUMENT", targetId: String(d._id) }); out.push({ kind: "BK_DOCUMENT", id: String(d._id), party: d.fields?.customer?.value || d.fields?.vendor?.value || "", number: d.fields?.invoiceNumber?.value || "", total, open: Math.max(0, fromCents(cents(total) - cents(alloc))), currency: d.fields?.currency?.value || "USD", date: d.fields?.invoiceDate?.value || d.createdAt.slice(0, 10), dueDate: d.fields?.dueDate?.value || null, poNumber: d.fields?.purchaseOrderNumber?.value || null, reference: d.fields?.paymentReference?.value || null, departmentId: d.departmentId, status: d.status }); }
  } else {
    const docs = await c.bkDocuments.find({ orgId: oid, documentType: { $in: ["SUPPLIER_INVOICE", "RECEIPT", "DEBIT_NOTE"] }, status: { $in: ["EXTRACTED", "NEEDS_REVIEW", "PROCESSED"] } }).limit(2000).toArray();
    for (const d of docs) { const total = d.fields?.total?.value; if (!(total > 0)) continue; const alloc = await allocatedFor({ orgId, targetKind: "BK_DOCUMENT", targetId: String(d._id) }); out.push({ kind: "BK_DOCUMENT", id: String(d._id), party: d.fields?.vendor?.value || "", number: d.fields?.invoiceNumber?.value || "", total, open: Math.max(0, fromCents(cents(total) - cents(alloc))), currency: d.fields?.currency?.value || "USD", date: d.fields?.invoiceDate?.value || d.createdAt.slice(0, 10), dueDate: d.fields?.dueDate?.value || null, poNumber: d.fields?.purchaseOrderNumber?.value || null, reference: d.fields?.paymentReference?.value || null, departmentId: d.departmentId, status: d.status }); }
    const exps = await c.expenses.find({ orgId: oid, deletedAt: null, status: { $in: ["APPROVED", "PENDING_APPROVAL"] } }).sort({ expenseDate: -1 }).limit(1500).toArray();
    for (const e of exps) { const alloc = await allocatedFor({ orgId, targetKind: "EXPENSE", targetId: String(e._id) }); out.push({ kind: "EXPENSE", id: String(e._id), party: e.vendor || "", number: "", total: e.amount, open: Math.max(0, fromCents(cents(e.amount) - cents(alloc))), currency: e.currency || "USD", date: String(e.expenseDate || "").slice(0, 10), dueDate: null, poNumber: null, reference: null, departmentId: e.departmentId, status: e.status }); }
  }
  void dept;
  return out.filter((x) => x.open > 0 || x.alreadyPaid);
}

const txnText = (t) => normText(`${t.description || ""} ${t.reference || ""} ${t.counterparty || ""}`);
/** True when the invoice number appears as its own token in the text (separators between its parts may vary: INV-1001, INV 1001, INV/1001). */
const refInText = (number, text) => {
  const raw = String(number || "").trim(); if (raw.replace(/[^A-Za-z0-9]/g, "").length < 3) return false;
  const parts = raw.split(/[^A-Za-z0-9]+/).filter(Boolean).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`(?<![A-Za-z0-9])${parts.join("[\\s\\-_/.]*")}(?![A-Za-z0-9])`, "i").test(String(text || ""));
};

/**
 * Scores one transaction against ONE candidate. Pure. Returns { confidence, type, signals{}, explanation[], discrepancy|null, allocation }.
 * Confidence rules (the same every time):
 *   reference + exact amount ............ 0.995, +0.004 when the party also matches            (the reference-image "99.9%" case)
 *   reference + different amount ........ 0.70 (partial payment: 0.90)                          a real reference with a wrong amount is a discrepancy
 *   no reference, exact amount + party .. 0.96, +0.02 inside the date window, +0.01 on a PO hit  never reaches the 0.99 default on its own
 *   exact amount + fuzzy party (>=0.8) .. 0.85
 *   exact amount only ................... 0.55
 *   a different currency ................ capped at 0.85; unconvertible pairs are not comparable
 */
export function scoreCandidate({ txn, cand, settings }) {
  const m = settings.matching; const explanation = []; const signals = {};
  const text = `${txn.description || ""} ${txn.reference || ""}`;
  const cur = comparableAmount(txn.amount, txn.currency, cand.currency);
  if (cur.error) return { confidence: 0, type: "NOT_COMPARABLE", signals: { currency: "unconvertible" }, explanation: [cur.error], discrepancy: cur.error, allocation: 0 };
  signals.currencyConverted = cur.converted;
  const amt = cur.amount;
  const ref = refInText(cand.number, text) || (cand.reference && refInText(cand.reference, text));
  signals.reference = !!ref;
  const diff = fromCents(cents(amt) - cents(cand.open));
  const exact = Math.abs(diff) <= m.amountTolerance; signals.amountExact = exact;
  const feeOk = !exact && diff < 0 && Math.abs(diff) <= cand.open * m.feeTolerancePct; signals.withinFeeTolerance = feeOk;
  const partial = !exact && !feeOk && diff < 0; const over = !exact && diff > 0;
  const party = Math.max(vendorSimilarity(txn.counterparty || "", cand.party), vendorSimilarity(txnText(txn), cand.party), cand.party && normText(txn.description).includes(normText(cand.party)) ? 0.95 : 0);
  signals.partySimilarity = round4(party); signals.partyExact = party >= 0.95;
  const refDate = cand.dueDate || cand.date;
  const dd = refDate ? daysBetween(txn.date, refDate) : null; signals.dateGapDays = dd; signals.withinDateWindow = dd !== null && dd <= m.dateWindowDays;
  const poHit = !!(cand.poNumber && normText(text).replace(/\s/g, "").includes(normText(cand.poNumber).replace(/\s/g, ""))); signals.purchaseOrder = poHit;

  let confidence = 0; let type = "NONE";
  if (ref && (exact || feeOk)) { confidence = 0.995 + (party >= 0.9 ? 0.004 : 0); type = exact ? "EXACT" : "FEES"; if (feeOk) confidence = Math.min(confidence, 0.97); }
  else if (ref && partial) { confidence = 0.9; type = "PARTIAL"; }
  else if (ref && over) { confidence = 0.7; type = "OVERPAYMENT"; }
  else if (ref) { confidence = 0.7; type = "AMOUNT_MISMATCH"; }
  else if (exact && party >= 0.95) { confidence = 0.96 + (signals.withinDateWindow ? 0.02 : 0) + (poHit ? 0.01 : 0); type = "EXACT"; }
  else if (exact && party >= 0.8) { confidence = 0.85; type = "EXACT"; }
  else if (feeOk && party >= 0.95) { confidence = 0.9; type = "FEES"; }
  else if (partial && party >= 0.95 && !ref) { confidence = 0.6; type = "PARTIAL"; }
  else if (exact) { confidence = 0.55; type = "EXACT"; }
  if (cur.converted) { confidence = Math.min(confidence, 0.85); if (type !== "NONE") type = `${type}_CURRENCY`; }
  if (cand.alreadyPaid && confidence > 0) { explanation.push("The invoice is already marked paid in Inaya."); }

  if (ref) explanation.push(`The transaction text contains the invoice number ${cand.number || cand.reference}.`);
  if (exact) explanation.push(`The amount matches exactly (${txn.currency} ${txn.amount.toFixed(2)}).`); else if (feeOk) explanation.push(`The amount is ${Math.abs(diff).toFixed(2)} below the open amount, within the ${(m.feeTolerancePct * 100).toFixed(1)}% fee tolerance.`); else if (partial) explanation.push(`The payment is ${Math.abs(diff).toFixed(2)} less than the open amount ${cand.open.toFixed(2)} (partial payment or underpayment).`); else if (over) explanation.push(`The payment is ${diff.toFixed(2)} more than the open amount ${cand.open.toFixed(2)} (overpayment).`);
  if (signals.partyExact) explanation.push(`The counterparty matches ${cand.party}.`); else if (party >= 0.8) explanation.push(`The counterparty is similar to ${cand.party} (${Math.round(party * 100)}%).`); else if (cand.party) explanation.push(`The counterparty does not clearly match ${cand.party}.`);
  if (signals.withinDateWindow) explanation.push(`The payment is ${dd} day(s) from ${cand.dueDate ? "the due date" : "the invoice date"}.`);
  if (poHit) explanation.push(`The purchase order ${cand.poNumber} is referenced.`);
  if (cur.converted) explanation.push(`Currencies differ (${txn.currency} vs ${cand.currency}); converted with the reference table dated ${cur.rateDate}. Confirm before relying on it.`);

  const discrepancy = type.startsWith("PARTIAL") ? `Underpaid by ${Math.abs(diff).toFixed(2)}` : type.startsWith("OVERPAYMENT") || (over && type !== "NONE") ? `Overpaid by ${diff.toFixed(2)}` : type.startsWith("AMOUNT_MISMATCH") ? `Amount differs by ${diff.toFixed(2)}` : null;
  const allocation = type === "NONE" ? 0 : Math.min(txn.amount, cur.converted ? txn.amount : cand.open);
  return { confidence: round4(clamp01(confidence)), type, signals, explanation, discrepancy, allocation };
}

/** One payment covering several invoices of the same party (small subset search, exact sum). */
export function combinedMatch({ txn, candidates, settings }) {
  const max = settings.matching.maxCombination; const text = `${txn.description || ""} ${txn.reference || ""}`;
  const pool = candidates.filter((c) => c.currency === txn.currency && c.open > 0 && (vendorSimilarity(txn.counterparty || txn.description || "", c.party) >= 0.9 || refInText(c.number, text))).slice(0, 14);
  const target = cents(txn.amount); let best = null;
  const walk = (start, chosen, sum) => {
    if (chosen.length >= 2 && Math.abs(sum - target) <= cents(settings.matching.amountTolerance)) { const refs = chosen.filter((c) => refInText(c.number, text)).length; const score = refs === chosen.length ? 0.985 : refs > 0 ? 0.93 : 0.9; if (!best || score > best.confidence || (score === best.confidence && chosen.length < best.parts.length)) best = { confidence: score, parts: chosen.slice(), refs }; return; }
    if (chosen.length >= max || sum > target + cents(1)) return;
    for (let i = start; i < pool.length; i++) { chosen.push(pool[i]); walk(i + 1, chosen, sum + cents(pool[i].open)); chosen.pop(); }
  };
  walk(0, [], 0);
  if (!best) return null;
  return { type: "COMBINED", confidence: round4(best.confidence), parts: best.parts.map((c) => ({ kind: c.kind, id: c.id, number: c.number, party: c.party, allocation: c.open })), explanation: [`One payment of ${txn.currency} ${txn.amount.toFixed(2)} equals the open amounts of ${best.parts.length} invoices (${best.parts.map((c) => c.number || c.id).join(", ")}).`, best.refs ? `${best.refs} of them are referenced in the payment text.` : "None is referenced in the payment text."], signals: { combined: true, referencedParts: best.refs } };
}

/**
 * Finds the best explanation for one bank transaction. Returns
 * { best, alternatives[], combined|null, decision: 'NONE'|'MATCH'|'AMBIGUOUS', ties }.
 * A tie between two candidates with the same top score is AMBIGUOUS: never guessed.
 */
export const MIN_SUGGESTION = 0.6; // weaker signals (for example an amount that merely happens to be equal) are noise, not suggestions

export async function findMatches({ orgId, txn, settings, candidates = null }) {
  let cands = candidates || await loadCandidates({ orgId, txn });
  // a suggestion a person already rejected for THIS transaction is never offered again
  const { bkMatches } = await getBookkeeperCollections();
  const rejected = new Set((await bkMatches.find({ orgId: toObjectId(orgId), transactionId: txn._id, status: "REJECTED", rejectedBy: { $exists: true } }).project({ targetKind: 1, targetId: 1 }).toArray()).map((r) => `${r.targetKind}:${r.targetId}`));
  if (rejected.size) cands = cands.filter((c) => !rejected.has(`${c.kind}:${c.id}`));
  const scored = cands.map((cand) => ({ cand, ...scoreCandidate({ txn, cand, settings }) })).filter((s) => s.confidence >= MIN_SUGGESTION).sort((a, b) => b.confidence - a.confidence);
  const combined = combinedMatch({ txn, candidates: cands, settings });
  const top = scored[0] || null; const second = scored[1] || null;
  const ambiguous = !!(top && second && top.confidence >= 0.85 && second.confidence >= top.confidence - 0.005 && second.cand.id !== top.cand.id && !(top.signals.reference && !second.signals.reference));
  let decision = !top && !combined ? "NONE" : "MATCH";
  if (combined && (!top || combined.confidence > top.confidence)) return { best: null, combined, alternatives: scored.slice(0, 3), decision: "MATCH", ambiguous: false };
  if (ambiguous) decision = "AMBIGUOUS";
  return { best: top, combined: null, alternatives: scored.slice(1, 4), decision, ambiguous };
}

// ------------------------------------------------------------------------------------------------------------------ three-way match
/** SOW 16: purchase order + supplier invoice + receipt. Uses the real PO items (quantity, unitPrice, receivedQuantity). Read-only. */
export async function threeWayMatch({ orgId, doc, settings }) {
  const c = await getBookkeeperCollections(); const oid = toObjectId(orgId);
  const checks = []; const f = doc.fields || {};
  if (!doc.vendorId) return { status: "NOT_APPLICABLE", checks: [{ check: "supplier", ok: null, detail: "The vendor is not a known supplier, so no purchase order can be looked up." }] };
  const pos = await c.purchaseOrders.find({ orgId: oid, supplierId: doc.vendorId, deletedAt: null, status: { $in: ["ORDERED", "PARTIALLY_RECEIVED", "RECEIVED", "APPROVED"] } }).limit(200).toArray();
  const poNum = f.purchaseOrderNumber?.value ? normInvoiceNo(f.purchaseOrderNumber.value) : null;
  const total = (po) => (po.items || []).reduce((s, i) => s + (Number(i.quantity) || 0) * (Number(i.unitPrice) || 0), 0);
  let po = poNum ? pos.find((p) => normInvoiceNo(String(p._id)).endsWith(poNum) || normInvoiceNo(String(p._id).slice(-8)) === poNum) : null;
  if (!po && f.total?.value !== undefined) po = pos.find((p) => Math.abs(total(p) - f.total.value) <= Math.max(0.01, f.total.value * 0.005)) || null;
  if (!po) return { status: "NO_PURCHASE_ORDER", checks: [{ check: "purchase_order", ok: false, detail: poNum ? `Purchase order ${f.purchaseOrderNumber.value} was not found for this supplier.` : "No purchase order for this supplier matches the invoice." }] };
  checks.push({ check: "supplier", ok: true, detail: "Supplier matches the purchase order." });
  checks.push({ check: "purchase_order", ok: true, detail: `Purchase order ${String(po._id).slice(-8).toUpperCase()} (${po.status}).` });
  const poTotal = total(po); const totalOk = f.total?.value !== undefined && Math.abs(poTotal - f.total.value) <= Math.max(0.01, poTotal * 0.005) || (f.subtotal?.value !== undefined && Math.abs(poTotal - f.subtotal.value) <= Math.max(0.01, poTotal * 0.005));
  checks.push({ check: "total", ok: !!totalOk, detail: totalOk ? `Invoice total agrees with the order (${poTotal.toFixed(2)}).` : `The order totals ${poTotal.toFixed(2)}; the invoice states ${f.total?.value ?? "no total"}.` });
  const lines = doc.lineItems || [];
  for (const it of po.items || []) {
    const inv = lines.find((l) => vendorSimilarity(l.description, it.description) >= 0.8);
    if (!inv) { checks.push({ check: `item:${it.description}`, ok: lines.length ? false : null, detail: lines.length ? "This ordered item does not appear on the invoice." : "The invoice has no line items to compare." }); continue; }
    const qtyOk = Math.abs((inv.quantity ?? 0) - it.quantity) < 1e-9; const priceOk = Math.abs((inv.unitPrice ?? 0) - it.unitPrice) <= 0.01;
    checks.push({ check: `item:${it.description}`, ok: qtyOk && priceOk, detail: `Ordered ${it.quantity} at ${it.unitPrice}; invoiced ${inv.quantity} at ${inv.unitPrice}.` });
    const recvOk = (it.receivedQuantity || 0) >= (inv.quantity ?? 0);
    checks.push({ check: `received:${it.description}`, ok: recvOk, detail: recvOk ? `Received ${it.receivedQuantity} of ${it.quantity} ordered.` : `Only ${it.receivedQuantity || 0} received but ${inv.quantity} invoiced.` });
  }
  const bad = checks.filter((k) => k.ok === false).length;
  return { status: bad ? "MISMATCH" : "MATCHED", purchaseOrderId: String(po._id), checks };
}

