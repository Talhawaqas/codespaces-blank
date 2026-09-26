// src/lib/bookkeeper/reconcile.js
//
// AI Bookkeeper SOW sections 15, 19, 20, 22, 48: the reconciliation engine and the posting boundary.
//
// What runs by itself (INTERNAL state only): categorize a bank transaction, look for a match, score it, apply the policy, and link an
// AUTO_MATCHED match or queue a review item. Nothing an automated run does changes an invoice, expense or payment.
//
// What changes AUTHORITATIVE records (a person, or an explicit organization setting, is required):
//   * recordPayment  -> a `payments` row (RECORDED) for a confirmed match;
//   * postBill       -> a DRAFT expense for a captured supplier bill (the existing expense approval flow then applies);
//   * settleInvoice  -> "mark invoice paid" is only ever PROPOSED through the existing Controlled Actions (human approval + standard delay).
// There is no general ledger in Inaya, so there are no journal entries: "posted" means applied to those existing records.

import { toObjectId } from "../orgs.js";
import { proposeAiAction } from "../ai-action-requests.js";
import { getBookkeeperCollections } from "./db.js";
import { fail, nowIso, cents, fromCents, round4 } from "./common.js";
import { getSettings } from "./settings.js";
import { categorize, learnMapping } from "./categorize.js";
import { counterpartyKey } from "./categorize.js";
import { findMatches, threeWayMatch } from "./match.js";
import { checkTransaction } from "./anomaly.js";
import { decide } from "./policy.js";
import { audit, event, link, notify } from "./record.js";
import { reviewItem } from "./documents.js";

const oidOf = (id) => { try { return toObjectId(id); } catch { return null; } };

const REVIEW_TYPE_FOR = (type, ambiguous, anomalies) => anomalies.length ? "ANOMALY" : ambiguous ? "LOW_CONFIDENCE_MATCH" : /CURRENCY/.test(type) ? "CURRENCY_MISMATCH" : type === "OVERPAYMENT" ? "OVERPAYMENT" : type === "PARTIAL" ? "UNDERPAYMENT" : type === "AMOUNT_MISMATCH" ? "AMOUNT_MISMATCH" : "LOW_CONFIDENCE_MATCH";

async function setTxn(id, patch) { const { bkTransactions } = await getBookkeeperCollections(); await bkTransactions.updateOne({ _id: id }, { $set: { ...patch, updatedAt: nowIso() } }); }

/** Removes still-open SUGGESTED rows for a transaction so a re-run replaces its own suggestions instead of piling up. */
async function clearSuggestions(orgId, txnId) { const { bkMatches } = await getBookkeeperCollections(); await bkMatches.deleteMany({ orgId: toObjectId(orgId), transactionId: txnId, status: "SUGGESTED" }); }

/**
 * Processes ONE bank transaction end to end. Idempotent: a transaction already CONFIRMED / RECONCILED / REVERSED / DISPUTED is left alone.
 * Returns { status, decision, match?, review?, category }.
 */
export async function processTransaction({ orgId, txn, settings = null, actor = "ai-bookkeeper", useAi = true }) {
  const c = await getBookkeeperCollections(); const oid = toObjectId(orgId);
  if (["CONFIRMED", "RECONCILED", "REVERSED", "DISPUTED"].includes(txn.status)) return { status: txn.status, skipped: true };
  const s = settings || await getSettings(orgId);
  const L = (type, targetType, targetId, note) => link({ orgId, subjectType: "BOOKKEEPING_TRANSACTION", subjectId: txn._id, type, targetType, targetId, note });

  // 1. category (never overwrites a human-set category)
  let cat = { category: txn.category, confidence: txn.categoryConfidence, method: txn.categoryMethod, reason: txn.categoryReason };
  if (!txn.category || txn.category === "Uncategorized") {
    cat = await categorize({ orgId, txn, settings: s, actorEmail: actor, useAi });
    await setTxn(txn._id, { category: cat.category, categoryConfidence: cat.confidence, categoryMethod: cat.method, categoryReason: cat.reason, counterpartyKey: cat.key || counterpartyKey(txn) });
    if (cat.method !== "NONE") {
      await event({ orgId, type: "TRANSACTION_CATEGORIZED", recordId: txn._id, actorEmail: actor, metadata: { transactionId: String(txn._id), category: cat.category, confidence: cat.confidence, method: cat.method } });
      L(cat.method === "AI" ? "ANALYZED_BY" : "CHECKED_BY", "BK_CATEGORIZATION", txn._id, `${cat.method}: ${cat.reason}`.slice(0, 190));
    }
  } else if (!txn.counterpartyKey) await setTxn(txn._id, { counterpartyKey: counterpartyKey(txn) });
  const fresh = await c.bkTransactions.findOne({ _id: txn._id });

  // 2. anomalies (non-authoritative)
  const an = await checkTransaction({ orgId, txn: fresh });

  // 3. matching
  await clearSuggestions(orgId, txn._id);
  const found = await findMatches({ orgId, txn: fresh, settings: s });
  let status = "UNMATCHED"; let matchDoc = null; let decision = null; let review = null;
  const known = !!(found.best && found.best.cand.party) || !!(found.combined);
  const facts = { amount: fresh.amount, currency: fresh.currency, categorization: cat.method === "NONE" ? 0 : cat.confidence, category: cat.category, anomalies: an.flags, anomalyScore: an.score, knownCounterparty: known, purchaseOrderRequired: false, purchaseOrderPresent: !!found.best?.signals?.purchaseOrder, duplicate: an.flags.some((f) => f.code.startsWith("DUPLICATE_")), ambiguous: found.ambiguous };

  if (found.decision === "NONE") {
    facts.match = 0; decision = decide({ settings: s, facts }); status = "UNMATCHED";
  } else {
    const parts = found.combined ? found.combined.parts : [{ kind: found.best.cand.kind, id: found.best.cand.id, number: found.best.cand.number, party: found.best.cand.party, allocation: found.best.allocation }];
    const conf = found.combined ? found.combined.confidence : found.best.confidence; const type = found.combined ? "COMBINED" : found.best.type;
    facts.match = conf; facts.matchType = type; facts.currencyConverted = !!found.best?.signals?.currencyConverted; facts.knownCounterparty = true;
    decision = decide({ settings: s, facts });
    const explanation = found.combined ? found.combined.explanation : found.best.explanation;
    const now = nowIso();
    const rows = [];
    for (const p of parts) {
      const row = { orgId: oid, departmentId: fresh.departmentId, transactionId: txn._id, targetKind: p.kind, targetId: p.id, targetNumber: p.number || null, targetParty: p.party || null, matchType: type, confidence: conf, signals: found.combined ? found.combined.signals : found.best.signals, explanation, discrepancy: found.combined ? null : found.best.discrepancy, allocation: p.allocation, currency: fresh.currency, status: "SUGGESTED", decision: decision.decision, reasons: decision.reasons, alternatives: found.alternatives.slice(0, 3).map((a) => ({ kind: a.cand.kind, id: a.cand.id, number: a.cand.number, party: a.cand.party, confidence: a.confidence, type: a.type })), createdAt: now, updatedAt: now, createdBy: actor };
      row._id = (await c.bkMatches.insertOne(row)).insertedId; rows.push(row);
    }
    matchDoc = rows[0];
    const isReceipt = fresh.direction === "CREDIT";
    await event({ orgId, type: "PAYMENT_MATCH_SUGGESTED", recordId: txn._id, actorEmail: actor, metadata: { transactionId: String(txn._id), matchType: type, confidence: conf, targets: parts.map((p) => `${p.kind}:${p.id}`), decision: decision.decision, direction: fresh.direction } });
    for (const p of parts) L("REFERENCES", p.kind === "INVOICE" ? "INVOICE" : p.kind === "EXPENSE" ? "EXPENSE" : "BK_DOCUMENT", p.id, `${type} ${Math.round(conf * 1000) / 10}%`);
    L("CHECKED_BY", "BK_POLICY", txn._id, `${decision.decision}: ${decision.reasons[0] || ""}`.slice(0, 190));

    if (decision.decision === "AUTO") {
      status = "AUTO_MATCHED"; await c.bkMatches.updateMany({ _id: { $in: rows.map((r) => r._id) } }, { $set: { status: "AUTO_MATCHED", updatedAt: nowIso() } });
      await event({ orgId, type: isReceipt ? "CUSTOMER_RECEIPT_MATCHED" : "PAYMENT_MATCH_CONFIRMED", recordId: txn._id, actorEmail: actor, metadata: { transactionId: String(txn._id), auto: true, confidence: conf, matchType: type } });
    } else {
      status = "HUMAN_REVIEW";
      const rtype = REVIEW_TYPE_FOR(type, found.ambiguous, an.flags);
      const r = await reviewItem({ orgId, departmentId: fresh.departmentId, type: rtype, reason: (decision.reasons[0] || `Match confidence ${Math.round(conf * 1000) / 10}%`).slice(0, 300), recordKind: "TRANSACTION", recordId: txn._id, dedupeKey: `txn:${txn._id}:match`, confidence: conf, severity: decision.decision === "APPROVAL" ? "high" : "medium", detail: { matchType: type, explanation, alternatives: matchDoc.alternatives, requiresApproval: decision.decision === "APPROVAL" } });
      review = r;
      if (r.created) await event({ orgId, type: "HUMAN_REVIEW_STARTED", recordId: txn._id, actorEmail: actor, metadata: { transactionId: String(txn._id), reason: rtype, decision: decision.decision } });
    }
  }
  if (status === "UNMATCHED") {
    const age = Math.round((Date.now() - Date.parse(fresh.date)) / 86400000);
    if (an.flags.length || age > 14) {
      status = an.flags.length ? "HUMAN_REVIEW" : "EXCEPTION";
      const r = await reviewItem({ orgId, departmentId: fresh.departmentId, type: an.flags.length ? "ANOMALY" : (fresh.direction === "CREDIT" ? "UNMATCHED_RECEIPT" : "UNMATCHED_TRANSACTION"), reason: an.flags[0]?.detail || `No matching ${fresh.direction === "CREDIT" ? "customer invoice" : "bill or expense"} was found after ${age} days.`, recordKind: "TRANSACTION", recordId: txn._id, dedupeKey: `txn:${txn._id}:unmatched`, severity: an.flags.some((f) => f.severity === "high") ? "high" : "medium", detail: { anomalies: an.flags } });
      review = r;
      if (r.created) await event({ orgId, type: "RECONCILIATION_EXCEPTION", recordId: txn._id, actorEmail: actor, metadata: { transactionId: String(txn._id), reason: an.flags.length ? "anomaly" : "unmatched" } });
    }
  } else if (an.flags.length && status === "AUTO_MATCHED") { /* policy already routed anomalies to review; this branch keeps the type checker honest */ }

  await setTxn(txn._id, { status, decision: decision.decision, risk: decision.risk, decisionReasons: decision.reasons.slice(0, 8), anomalies: an.flags.map((f) => ({ code: f.code, severity: f.severity, detail: f.detail })), matchConfidence: facts.match ?? 0, processedAt: nowIso() });
  return { status, decision: decision.decision, risk: decision.risk, reasons: decision.reasons, match: matchDoc ? String(matchDoc._id) : null, category: cat.category, anomalies: an.flags, review: review?.created ? String(review.id) : null };
}

/**
 * Reconciles a set of transactions (a period, a source, or everything unreconciled). Idempotent: already-final transactions are skipped.
 * scope: { from, to, sourceId, departmentIds, limit }
 */
export async function reconcile({ orgId, scope = {}, actor = "ai-bookkeeper", useAi = true }) {
  const c = await getBookkeeperCollections(); const oid = toObjectId(orgId); const s = await getSettings(orgId);
  const q = { orgId: oid, status: { $in: ["UNMATCHED", "SUGGESTED", "EXCEPTION"] }, humanRejected: { $ne: true } }; // a person's rejection is final until they re-match
  if (scope.from || scope.to) q.date = { ...(scope.from ? { $gte: scope.from } : {}), ...(scope.to ? { $lte: scope.to } : {}) };
  if (scope.sourceId) { const sid = oidOf(scope.sourceId); if (!sid) return fail("sourceId is invalid."); q.sourceId = sid; }
  if (scope.departmentIds) q.departmentId = { $in: scope.departmentIds };
  const limit = Math.min(1000, scope.limit || 500);
  const started = nowIso();
  const run = { orgId: oid, scope: { from: scope.from || null, to: scope.to || null, sourceId: scope.sourceId || null }, status: "RUNNING", startedAt: started, createdBy: actor, createdAt: started, processed: 0, autoMatched: 0, humanReview: 0, unmatched: 0, exceptions: 0, approvals: 0 };
  run._id = (await c.bkReconciliations.insertOne(run)).insertedId;
  await event({ orgId, type: "RECONCILIATION_STARTED", recordId: run._id, actorEmail: actor, metadata: { reconciliationId: String(run._id), scope: run.scope } });
  const txns = await c.bkTransactions.find(q).sort({ date: 1 }).limit(limit).toArray();
  const counts = { processed: 0, autoMatched: 0, humanReview: 0, unmatched: 0, exceptions: 0, approvals: 0, failed: 0 };
  for (const t of txns) {
    try {
      const r = await processTransaction({ orgId, txn: t, settings: s, actor, useAi });
      counts.processed++; if (r.status === "AUTO_MATCHED") counts.autoMatched++; else if (r.status === "HUMAN_REVIEW") counts.humanReview++; else if (r.status === "EXCEPTION") counts.exceptions++; else counts.unmatched++;
      if (r.decision === "APPROVAL") counts.approvals++;
    } catch (err) { counts.failed++; console.error("bookkeeper transaction failed:", err.message); await c.bkTransactions.updateOne({ _id: t._id }, { $set: { lastError: String(err.message).slice(0, 200), updatedAt: nowIso() } }); }
  }
  const sweep = await sweepSettled({ orgId, actor });
  const finished = nowIso();
  await c.bkReconciliations.updateOne({ _id: run._id }, { $set: { ...counts, reconciled: sweep.reconciled, status: counts.failed ? "COMPLETED_WITH_ERRORS" : "COMPLETED", completedAt: finished } });
  await event({ orgId, type: "RECONCILIATION_COMPLETED", recordId: run._id, actorEmail: actor, metadata: { reconciliationId: String(run._id), ...counts, reconciled: sweep.reconciled } });
  if (counts.humanReview + counts.exceptions > 0) await notify({ orgId, title: `${counts.humanReview + counts.exceptions} bookkeeping item(s) need review`, body: `Reconciliation processed ${counts.processed}: ${counts.autoMatched} auto-matched, ${counts.humanReview} for review, ${counts.exceptions} exceptions.`, dedupeKey: `bk:recon:${run._id}`, severity: "warning", recordId: run._id });
  return { reconciliationId: String(run._id), ...counts, reconciled: sweep.reconciled, remaining: Math.max(0, (await c.bkTransactions.countDocuments(q))), status: counts.failed ? "COMPLETED_WITH_ERRORS" : "COMPLETED" };
}

/** A confirmed / auto match becomes RECONCILED once its target is really settled in the authoritative record. */
export async function sweepSettled({ orgId, actor = "ai-bookkeeper" }) {
  const c = await getBookkeeperCollections(); const oid = toObjectId(orgId); let reconciled = 0;
  const rows = await c.bkMatches.find({ orgId: oid, status: { $in: ["AUTO_MATCHED", "CONFIRMED"] } }).limit(1000).toArray();
  const byTxn = new Map(); for (const r of rows) { const k = String(r.transactionId); byTxn.set(k, [...(byTxn.get(k) || []), r]); }
  for (const [tid, ms] of byTxn) {
    let settled = true;
    for (const m of ms) {
      if (m.targetKind === "INVOICE") { const inv = await c.invoices.findOne({ _id: oidOf(m.targetId), orgId: oid }, { projection: { status: 1 } }); if (!inv || inv.status !== "PAID") { settled = false; break; } }
      else if (m.targetKind === "EXPENSE") { const ex = await c.expenses.findOne({ _id: oidOf(m.targetId), orgId: oid }, { projection: { status: 1 } }); if (!ex || ex.status !== "APPROVED") { settled = false; break; } }
      else if (m.targetKind === "BK_DOCUMENT") { if (m.status !== "CONFIRMED") { settled = false; break; } }
    }
    if (settled) {
      const r = await c.bkTransactions.updateOne({ _id: oidOf(tid), orgId: oid, status: { $in: ["AUTO_MATCHED", "CONFIRMED"] } }, { $set: { status: "RECONCILED", reconciledAt: nowIso(), updatedAt: nowIso() } });
      if (r.modifiedCount) { await c.bkMatches.updateMany({ _id: { $in: ms.map((m) => m._id) } }, { $set: { status: "RECONCILED", updatedAt: nowIso() } }); reconciled++; await audit({ orgId, recordId: oidOf(tid), action: "BOOKKEEPER_RECONCILED", actorEmail: actor, metadata: { transactionId: tid } }); link({ orgId, subjectType: "BOOKKEEPING_TRANSACTION", subjectId: oidOf(tid), type: "PROVEN_BY", targetType: "BK_RECONCILIATION", targetId: oidOf(tid), note: "target settled in the authoritative record" }); }
    }
  }
  return { reconciled };
}

// ------------------------------------------------------------------------------------------------------------------ human confirmation and posting
async function loadTxnMatches(orgId, txnId) { const c = await getBookkeeperCollections(); const id = oidOf(txnId); if (!id) return null; const txn = await c.bkTransactions.findOne({ _id: id, orgId: toObjectId(orgId) }); if (!txn) return null; const matches = await c.bkMatches.find({ orgId: toObjectId(orgId), transactionId: id, status: { $in: ["SUGGESTED", "AUTO_MATCHED", "CONFIRMED"] } }).toArray(); return { txn, matches }; }

/**
 * A person confirms the suggested match. This CONFIRMS the link and, when `post` is true, applies it to the authoritative records:
 * a RECORDED payment, and (for a fully paid customer invoice / approved expense) a Controlled Action PROPOSAL to mark it paid.
 */
export async function confirmMatch({ orgId, transactionId, membership, actorEmail, post = true, note = null }) {
  const got = await loadTxnMatches(orgId, transactionId); if (!got) return fail("Transaction not found.", 404);
  const { txn, matches } = got;
  if (!matches.length) return fail("There is no match to confirm. Choose one with rematch.", 409);
  if (["RECONCILED", "REVERSED", "DISPUTED"].includes(txn.status)) return fail(`The transaction is ${txn.status}.`, 409);
  const c = await getBookkeeperCollections();
  await c.bkMatches.updateMany({ _id: { $in: matches.map((m) => m._id) } }, { $set: { status: "CONFIRMED", confirmedBy: actorEmail, confirmedAt: nowIso(), updatedAt: nowIso(), note } });
  await c.bkTransactions.updateOne({ _id: txn._id }, { $set: { status: "CONFIRMED", updatedAt: nowIso() } });
  await c.bkReviewItems.updateMany({ orgId: toObjectId(orgId), recordKind: "TRANSACTION", recordId: txn._id, status: "OPEN" }, { $set: { status: "RESOLVED", resolution: "match confirmed", resolvedBy: actorEmail, resolvedAt: nowIso() } });
  await event({ orgId, type: txn.direction === "CREDIT" ? "CUSTOMER_RECEIPT_MATCHED" : "PAYMENT_MATCH_CONFIRMED", recordId: txn._id, actorEmail, metadata: { transactionId: String(txn._id), auto: false, targets: matches.map((m) => `${m.targetKind}:${m.targetId}`) } });
  await event({ orgId, type: "HUMAN_REVIEW_COMPLETED", recordId: txn._id, actorEmail, metadata: { transactionId: String(txn._id), decision: "confirmed" } });
  link({ orgId, subjectType: "BOOKKEEPING_TRANSACTION", subjectId: txn._id, type: "APPROVED_BY", targetType: "BK_REVIEW", targetId: txn._id, note: `confirmed by ${actorEmail}`.slice(0, 190) });
  if (matches.some((m) => m.targetKind === "BK_DOCUMENT")) await c.bkDocuments.updateMany({ _id: { $in: matches.filter((m) => m.targetKind === "BK_DOCUMENT").map((m) => oidOf(m.targetId)) } }, { $set: { status: "PROCESSED", updatedAt: nowIso() } });
  let posted = null;
  if (post) posted = await postMatch({ orgId, txn, matches, membership, actorEmail });
  return { confirmed: true, posted };
}

/** Applies a confirmed match to the authoritative records. Idempotent: a match posts once. */
export async function postMatch({ orgId, txn, matches, membership, actorEmail }) {
  const c = await getBookkeeperCollections(); const oid = toObjectId(orgId); const out = { payments: [], proposals: [] };
  for (const m of matches) {
    if (m.paymentId) { out.payments.push(String(m.paymentId)); continue; }
    let expenseId = m.targetKind === "EXPENSE" ? oidOf(m.targetId) : null;
    if (m.targetKind === "BK_DOCUMENT" && txn.direction === "DEBIT") {
      // a matched supplier bill is applied first as a DRAFT expense (existing approval flow), then the payment is recorded against it
      const pb = await postBill({ orgId, documentId: m.targetId, membership, actorEmail });
      if (pb.expenseId) expenseId = oidOf(pb.expenseId); else (out.warnings = out.warnings || []).push(pb.error || "The bill could not be posted.");
    }
    const pay = { orgId: oid, departmentId: txn.departmentId, direction: txn.direction === "CREDIT" ? "INCOMING" : "OUTGOING", relatedInvoiceId: m.targetKind === "INVOICE" ? oidOf(m.targetId) : null, relatedExpenseId: expenseId, relatedPurchaseOrderId: null, amount: m.allocation, currency: txn.currency, method: "bank_transfer", paymentDate: txn.date, status: "RECORDED", createdByEmail: actorEmail, createdAt: nowIso(), deletedAt: null, source: "ai-bookkeeper", bankTransactionId: txn._id };
    const dupe = await c.payments.findOne({ orgId: oid, bankTransactionId: txn._id, relatedInvoiceId: pay.relatedInvoiceId, relatedExpenseId: pay.relatedExpenseId, amount: pay.amount, deletedAt: null });
    const id = dupe ? dupe._id : (await c.payments.insertOne(pay)).insertedId;
    await c.bkMatches.updateOne({ _id: m._id }, { $set: { paymentId: id, postedAt: nowIso(), postedBy: actorEmail } });
    out.payments.push(String(id));
    await event({ orgId, type: "FINANCIAL_RECORD_POSTED", recordId: txn._id, actorEmail, metadata: { transactionId: String(txn._id), paymentId: String(id), targetKind: m.targetKind, targetId: m.targetId, amount: m.allocation, currency: txn.currency } });
    link({ orgId, subjectType: "BOOKKEEPING_TRANSACTION", subjectId: txn._id, type: "EXECUTED_AS", targetType: "PAYMENT", targetId: id, note: `recorded payment ${m.allocation} ${txn.currency}` });
    if (m.targetKind === "INVOICE") {
      const inv = await c.invoices.findOne({ _id: oidOf(m.targetId), orgId: oid });
      if (inv && inv.status !== "PAID") {
        const total = cents(inv.total); const paid = (await c.bkMatches.find({ orgId: oid, targetKind: "INVOICE", targetId: m.targetId, status: { $in: ["AUTO_MATCHED", "CONFIRMED", "RECONCILED"] } }).toArray()).reduce((s, x) => s + cents(x.allocation), 0);
        if (paid >= total) { const p = await settleInvoice({ orgId, invoice: inv, txn, actorEmail }); if (p) out.proposals.push(p); }
      }
    }
  }
  return out;
}

/** "Mark invoice paid" is consequential: it is PROPOSED through the existing Controlled Actions, never applied here. */
export async function settleInvoice({ orgId, invoice, txn, actorEmail }) {
  const r = await proposeAiAction({
    orgId, assistantSurface: "business", toolName: "propose_invoice_decision", targetRecordType: "INVOICE", targetRecordId: invoice._id, proposedAction: "markPaid",
    args: { invoiceId: String(invoice._id), action: "markPaid" }, requestedContextSummary: `Mark invoice ${invoice.invoiceNumber} (${invoice.currency} ${invoice.total}) paid: matched to bank receipt of ${txn.currency} ${txn.amount.toFixed(2)} on ${txn.date} by AI Bookkeeper.`,
    actorEmail: actorEmail || "ai-bookkeeper", canPropose: true,
  });
  if (r.error) return { error: r.error };
  await audit({ orgId, recordId: txn._id, action: "BOOKKEEPER_SETTLEMENT_PROPOSED", actorEmail, metadata: { invoiceId: String(invoice._id), requestId: String(r.request._id), transactionId: String(txn._id) } });
  link({ orgId, subjectType: "BOOKKEEPING_TRANSACTION", subjectId: txn._id, type: "REQUIRES", targetType: "AI_ACTION_REQUEST", targetId: r.request._id, note: "mark invoice paid awaits human approval" });
  return { requestId: String(r.request._id), deduped: !!r.deduped, invoiceId: String(invoice._id) };
}

/** Posts a captured supplier bill as a DRAFT expense (existing expense approval applies afterwards). Idempotent per document. */
export async function postBill({ orgId, documentId, membership, actorEmail }) {
  const c = await getBookkeeperCollections(); const oid = toObjectId(orgId); const id = oidOf(documentId); if (!id) return fail("Document not found.", 404);
  const doc = await c.bkDocuments.findOne({ _id: id, orgId: oid }); if (!doc) return fail("Document not found.", 404);
  if (doc.postedExpenseId) return { posted: true, expenseId: String(doc.postedExpenseId), already: true };
  if (!["EXTRACTED", "PROCESSED", "NEEDS_REVIEW"].includes(doc.status)) return fail(`A ${doc.status} document cannot be posted.`, 409);
  if (!["SUPPLIER_INVOICE", "RECEIPT"].includes(doc.documentType)) return fail("Only supplier invoices and receipts are posted as expenses.", 409);
  const f = doc.fields || {};
  if (!(f.total?.value > 0) || !f.vendor?.value) return fail("The document needs a vendor and a total before it can be posted.", 409);
  if (doc.status === "NEEDS_REVIEW" && !doc.humanVerified) return fail("A person must verify this document's extracted fields before it is posted.", 409, { reasonCode: "REVIEW_REQUIRED" });
  const exp = await c.expenses.insertOne({ orgId: oid, departmentId: doc.departmentId, vendor: String(f.vendor.value).slice(0, 120), category: doc.category || "Uncategorized", amount: f.total.value, currency: f.currency?.value || "USD", expenseDate: f.invoiceDate?.value || nowIso(), description: `From ${doc.filename}${f.invoiceNumber?.value ? ` (invoice ${f.invoiceNumber.value})` : ""}`, status: "DRAFT", createdByEmail: actorEmail, createdAt: nowIso(), updatedAt: nowIso(), deletedAt: null, source: "ai-bookkeeper", bookkeeperDocumentId: doc._id });
  await c.bkDocuments.updateOne({ _id: id }, { $set: { postedExpenseId: exp.insertedId, postedAt: nowIso(), postedBy: actorEmail, status: "PROCESSED", updatedAt: nowIso() } });
  await event({ orgId, type: "FINANCIAL_RECORD_POSTED", recordId: id, actorEmail, metadata: { documentId: String(id), expenseId: String(exp.insertedId), amount: f.total.value } });
  link({ orgId, subjectType: "BOOKKEEPING_DOCUMENT", subjectId: id, type: "EXECUTED_AS", targetType: "EXPENSE", targetId: exp.insertedId, note: "draft expense created; the expense approval flow applies" });
  return { posted: true, expenseId: String(exp.insertedId), status: "DRAFT" };
}

/** Reverses a posting decision: unlinks the match. It never deletes a payment (that stays visible and is reversed in Finance). */
export async function reverseMatch({ orgId, transactionId, actorEmail, reason }) {
  const got = await loadTxnMatches(orgId, transactionId); if (!got) return fail("Transaction not found.", 404);
  const c = await getBookkeeperCollections();
  await c.bkMatches.updateMany({ orgId: toObjectId(orgId), transactionId: got.txn._id, status: { $in: ["SUGGESTED", "AUTO_MATCHED", "CONFIRMED", "RECONCILED"] } }, { $set: { status: "REVERSED", reversedBy: actorEmail, reversedAt: nowIso(), reversalReason: String(reason || "").slice(0, 200), updatedAt: nowIso() } });
  await c.bkTransactions.updateOne({ _id: got.txn._id }, { $set: { status: "UNMATCHED", updatedAt: nowIso() } });
  await event({ orgId, type: "FINANCIAL_RECORD_REVERSED", recordId: got.txn._id, actorEmail, metadata: { transactionId: String(got.txn._id), reason: String(reason || "").slice(0, 120) } });
  return { reversed: true, note: "Any payment already recorded stays in Finance and must be reversed there." };
}

export { threeWayMatch, learnMapping, fromCents, round4 };
