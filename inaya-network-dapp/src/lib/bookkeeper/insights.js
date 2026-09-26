// src/lib/bookkeeper/insights.js
//
// AI Bookkeeper SOW sections 24, 25, 26, 28, 43: the dashboard numbers, the recent-transactions table, finance reports (CSV) and the
// validated metrics fed to Business Insights. Every figure is COUNTED from stored records, scoped to the departments the caller may see;
// nothing is estimated, and no "savings" figure is ever produced (the reference image's dollar claim is not reproduced).

import { toObjectId } from "../orgs.js";
import { getBookkeeperCollections } from "./db.js";
import { cents, fromCents, nowIso, round4, comparableAmount } from "./common.js";
import { txnView } from "./review.js";

const scope = (orgId, departmentIds) => ({ orgId: toObjectId(orgId), ...(departmentIds ? { departmentId: { $in: departmentIds } } : {}) });
const pctOf = (n, d) => (d > 0 ? round4(n / d) : null);

/** Dashboard cards (SOW 24). */
export async function overview({ orgId, departmentIds = null }) {
  const c = await getBookkeeperCollections(); const q = scope(orgId, departmentIds);
  const [byStatus, catAgg, docAgg, openReview, posted, sources, recon, docs] = await Promise.all([
    c.bkTransactions.aggregate([{ $match: q }, { $group: { _id: "$status", n: { $sum: 1 } } }]).toArray(),
    c.bkTransactions.aggregate([{ $match: { ...q, category: { $nin: [null, "Uncategorized"] }, categoryMethod: { $in: ["RULE", "HUMAN_MAPPING", "HISTORY", "AI"] } } }, { $count: "n" }]).toArray(),
    c.bkDocuments.aggregate([{ $match: q }, { $group: { _id: "$status", n: { $sum: 1 } } }]).toArray(),
    c.bkReviewItems.countDocuments({ ...q, status: "OPEN" }),
    c.bkMatches.countDocuments({ ...q, paymentId: { $exists: true, $ne: null } }),
    c.bkSources.find({ orgId: toObjectId(orgId), status: "ACTIVE" }).project({ type: 1, name: 1, lastSyncStatus: 1, lastSyncAt: 1, lastSyncError: 1 }).toArray(),
    c.bkReconciliations.find({ orgId: toObjectId(orgId) }).sort({ createdAt: -1 }).limit(1).toArray(),
    c.bkDocuments.countDocuments({ ...q, postedExpenseId: { $exists: true, $ne: null } }),
  ]);
  const st = Object.fromEntries(byStatus.map((r) => [r._id, r.n])); const ds = Object.fromEntries(docAgg.map((r) => [r._id, r.n]));
  const total = Object.values(st).reduce((a, b) => a + b, 0);
  const matched = (st.AUTO_MATCHED || 0) + (st.CONFIRMED || 0) + (st.RECONCILED || 0);
  return {
    status: sources.some((s) => s.lastSyncStatus === "FAILED") ? "ATTENTION" : "RUNNING", generatedAt: nowIso(),
    cards: {
      autoCategorized: catAgg[0]?.n || 0, autoMatched: (st.AUTO_MATCHED || 0) + (st.RECONCILED || 0), posted: posted + docs, forReview: openReview, unmatched: (st.UNMATCHED || 0) + (st.EXCEPTION || 0), exceptions: st.EXCEPTION || 0,
      duplicates: ds.DUPLICATE || 0, documentsCaptured: Object.values(ds).reduce((a, b) => a + b, 0), failedProcessing: ds.FAILED || 0,
      reconciliationRate: pctOf(matched, total), transactionsTotal: total,
    },
    transactionsByStatus: st, documentsByStatus: ds,
    sources: sources.map((s) => ({ sourceId: String(s._id), type: s.type, name: s.name, lastSyncStatus: s.lastSyncStatus || null, lastSyncAt: s.lastSyncAt || null, lastSyncError: s.lastSyncError || null })),
    lastReconciliation: recon[0] ? { reconciliationId: String(recon[0]._id), status: recon[0].status, processed: recon[0].processed, autoMatched: recon[0].autoMatched, humanReview: recon[0].humanReview, completedAt: recon[0].completedAt || null } : null,
    note: "All figures are counted from stored records. No time or cost savings are estimated.",
  };
}

/** Recent transactions table with filters (SOW 25). */
export async function listTransactions({ orgId, departmentIds = null, from = null, to = null, sourceId = null, category = null, status = null, direction = null, counterparty = null, minConfidence = null, exception = false, limit = 50, skip = 0 }) {
  const c = await getBookkeeperCollections(); const q = scope(orgId, departmentIds);
  if (from || to) q.date = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  if (sourceId) { try { q.sourceId = toObjectId(sourceId); } catch { /* ignore invalid */ } }
  if (category) q.category = category; if (status) q.status = status; if (direction) q.direction = direction;
  if (counterparty) q.counterpartyKey = { $regex: String(counterparty).toLowerCase().replace(/[^a-z0-9 ]/g, "").slice(0, 40) };
  if (minConfidence !== null && Number.isFinite(minConfidence)) q.matchConfidence = { $gte: minConfidence };
  if (exception) q.status = { $in: ["EXCEPTION", "HUMAN_REVIEW"] };
  const [rows, total] = await Promise.all([c.bkTransactions.find(q).sort({ date: -1, _id: -1 }).skip(Math.max(0, skip)).limit(Math.min(200, limit)).toArray(), c.bkTransactions.countDocuments(q)]);
  const ids = rows.map((r) => r._id);
  const matches = ids.length ? await c.bkMatches.find({ orgId: toObjectId(orgId), transactionId: { $in: ids }, status: { $in: ["SUGGESTED", "AUTO_MATCHED", "CONFIRMED", "RECONCILED"] } }).toArray() : [];
  const by = new Map(); for (const m of matches) by.set(String(m.transactionId), [...(by.get(String(m.transactionId)) || []), m]);
  return { total, transactions: rows.map((t) => ({ ...txnView(t), match: (by.get(String(t._id)) || []).map((m) => ({ targetKind: m.targetKind, targetId: m.targetId, number: m.targetNumber, party: m.targetParty, type: m.matchType, confidence: m.confidence, status: m.status })) })) };
}

// ------------------------------------------------------------------------------------------------------------------ reports
export const REPORT_TYPES = ["transactions", "invoices", "bills", "receipts", "reconciliation", "unmatched", "exceptions", "duplicates", "supplier_spend", "customer_receipts", "aging", "category_spend", "cash_movement", "processing_accuracy"];

const csvCell = (v) => { let s = v === null || v === undefined ? "" : String(v); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export const toCsv = ({ meta, columns, rows }) => [
  ...Object.entries(meta).map(([k, v]) => `# ${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`),
  columns.join(","), ...rows.map((r) => columns.map((k) => csvCell(r[k])).join(",")),
].join("\n");

export async function buildReport({ orgId, orgName = null, type, departmentIds = null, from = null, to = null, filters = {}, actorEmail }) {
  if (!REPORT_TYPES.includes(type)) return { error: `type must be one of ${REPORT_TYPES.join(", ")}.`, status: 400 };
  const c = await getBookkeeperCollections(); const oid = toObjectId(orgId); const q = scope(orgId, departmentIds);
  const dq = from || to ? { date: { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) } } : {};
  let columns = []; let rows = [];
  const tx = () => c.bkTransactions.find({ ...q, ...dq }).sort({ date: 1 }).limit(20000).toArray();
  if (type === "transactions" || type === "unmatched" || type === "exceptions") {
    const list = (await tx()).filter((t) => type === "transactions" || (type === "unmatched" ? ["UNMATCHED", "EXCEPTION"].includes(t.status) : ["EXCEPTION", "HUMAN_REVIEW"].includes(t.status)));
    columns = ["date", "description", "counterparty", "direction", "amount", "currency", "category", "categoryMethod", "categoryConfidence", "matchConfidence", "status", "source", "transactionId"];
    rows = list.map((t) => ({ date: t.date, description: t.description, counterparty: t.counterparty, direction: t.direction, amount: t.amount, currency: t.currency, category: t.category, categoryMethod: t.categoryMethod, categoryConfidence: t.categoryConfidence, matchConfidence: t.matchConfidence, status: t.status, source: t.source, transactionId: String(t._id) }));
  } else if (["invoices", "bills", "receipts", "duplicates"].includes(type)) {
    const types = { invoices: ["CUSTOMER_INVOICE"], bills: ["SUPPLIER_INVOICE"], receipts: ["RECEIPT"], duplicates: null }[type];
    const dqd = from || to ? { createdAt: { ...(from ? { $gte: from } : {}), ...(to ? { $lte: `${to}T23:59:59Z` } : {}) } } : {};
    const docs = await c.bkDocuments.find({ ...q, ...dqd, ...(types ? { documentType: { $in: types } } : { status: "DUPLICATE" }) }).sort({ createdAt: 1 }).limit(20000).toArray();
    columns = ["invoiceDate", "vendor", "customer", "invoiceNumber", "currency", "total", "dueDate", "status", "channel", "extractionConfidence", "duplicateOf", "documentId"];
    rows = docs.map((d) => ({ invoiceDate: d.fields?.invoiceDate?.value, vendor: d.fields?.vendor?.value, customer: d.fields?.customer?.value, invoiceNumber: d.fields?.invoiceNumber?.value, currency: d.fields?.currency?.value, total: d.fields?.total?.value, dueDate: d.fields?.dueDate?.value, status: d.status, channel: d.channel, extractionConfidence: d.extractionConfidence, duplicateOf: d.duplicateOf ? String(d.duplicateOf) : "", documentId: String(d._id) }));
  } else if (type === "reconciliation") {
    const runs = await c.bkReconciliations.find({ orgId: oid }).sort({ createdAt: -1 }).limit(200).toArray();
    columns = ["startedAt", "completedAt", "status", "processed", "autoMatched", "humanReview", "unmatched", "exceptions", "reconciled", "reconciliationId"];
    rows = runs.map((r) => ({ startedAt: r.startedAt, completedAt: r.completedAt, status: r.status, processed: r.processed, autoMatched: r.autoMatched, humanReview: r.humanReview, unmatched: r.unmatched, exceptions: r.exceptions, reconciled: r.reconciled, reconciliationId: String(r._id) }));
  } else if (type === "supplier_spend" || type === "customer_receipts" || type === "category_spend") {
    const list = (await tx()).filter((t) => type === "customer_receipts" ? t.direction === "CREDIT" : t.direction === "DEBIT");
    const agg = new Map();
    for (const t of list) { const key = type === "category_spend" ? (t.category || "Uncategorized") : (t.counterparty || t.counterpartyKey || t.description); const k = `${key}|${t.currency}`; const a = agg.get(k) || { name: key, currency: t.currency, count: 0, cents: 0 }; a.count++; a.cents += cents(t.amount); agg.set(k, a); }
    columns = [type === "category_spend" ? "category" : type === "supplier_spend" ? "supplier" : "customer", "currency", "transactions", "total"];
    rows = [...agg.values()].sort((a, b) => b.cents - a.cents).map((a) => ({ [columns[0]]: a.name, currency: a.currency, transactions: a.count, total: fromCents(a.cents) }));
  } else if (type === "cash_movement") {
    const list = await tx(); const agg = new Map();
    for (const t of list) { const m = t.date.slice(0, 7); const k = `${m}|${t.currency}`; const a = agg.get(k) || { month: m, currency: t.currency, inCents: 0, outCents: 0 }; if (t.direction === "CREDIT") a.inCents += cents(t.amount); else a.outCents += cents(t.amount); agg.set(k, a); }
    columns = ["month", "currency", "moneyIn", "moneyOut", "net"];
    rows = [...agg.values()].sort((a, b) => a.month.localeCompare(b.month)).map((a) => ({ month: a.month, currency: a.currency, moneyIn: fromCents(a.inCents), moneyOut: fromCents(a.outCents), net: fromCents(a.inCents - a.outCents) }));
  } else if (type === "aging") {
    const invs = await c.invoices.find({ orgId: oid, deletedAt: null, status: { $in: ["SENT", "OVERDUE"] }, ...(departmentIds ? { departmentId: { $in: departmentIds } } : {}) }).limit(20000).toArray();
    const now = Date.now(); const buckets = ["current", "1-30", "31-60", "61-90", "90+"]; const agg = new Map();
    for (const i of invs) { const days = i.dueDate ? Math.floor((now - Date.parse(i.dueDate)) / 86400000) : 0; const b = days <= 0 ? "current" : days <= 30 ? "1-30" : days <= 60 ? "31-60" : days <= 90 ? "61-90" : "90+"; const k = `${b}|${i.currency || "USD"}`; const a = agg.get(k) || { bucket: b, currency: i.currency || "USD", count: 0, cents: 0 }; a.count++; a.cents += cents(i.total); agg.set(k, a); }
    columns = ["bucket", "currency", "invoices", "outstanding"];
    rows = [...agg.values()].sort((a, b) => buckets.indexOf(a.bucket) - buckets.indexOf(b.bucket)).map((a) => ({ bucket: a.bucket, currency: a.currency, invoices: a.count, outstanding: fromCents(a.cents) }));
  } else if (type === "processing_accuracy") {
    const [auto, rejected, reversed, review, docs, humanEdited] = await Promise.all([
      c.bkMatches.countDocuments({ ...q, createdBy: "ai-bookkeeper", status: { $in: ["AUTO_MATCHED", "CONFIRMED", "RECONCILED"] }, decision: "AUTO" }), c.bkMatches.countDocuments({ ...q, createdBy: "ai-bookkeeper", status: "REJECTED" }), c.bkMatches.countDocuments({ ...q, createdBy: "ai-bookkeeper", status: "REVERSED" }),
      c.bkReviewItems.countDocuments({ ...q }), c.bkDocuments.countDocuments({ ...q }), c.bkDocuments.countDocuments({ ...q, "fields.total.source": "human" }),
    ]);
    columns = ["measure", "value"];
    rows = [{ measure: "Automatic matches still standing", value: auto }, { measure: "Suggested matches rejected by a person", value: rejected }, { measure: "Automatic matches later reversed", value: reversed }, { measure: "Match suggestions overturned rate", value: pctOf(rejected + reversed, auto + rejected + reversed) ?? "n/a" }, { measure: "Review items raised", value: review }, { measure: "Documents captured", value: docs }, { measure: "Documents where a person corrected the total", value: humanEdited }];
  }
  const meta = { report: type, organization: orgName || String(orgId), generatedAt: nowIso(), generatedBy: actorEmail || "system", period: `${from || "all"} to ${to || "all"}`, sourceScope: departmentIds ? `${departmentIds.length} department(s) visible to the requester` : "all departments", filters: JSON.stringify(filters || {}), status: "Working report from AI Bookkeeper records; not a statutory or audited financial statement", evidence: "Every transaction/document row carries its id; open it in AI Bookkeeper > Evidence for the Evidence Graph and audit trail", rows: rows.length };
  return { meta, columns, rows };
}

// ------------------------------------------------------------------------------------------------------------------ Business Insights block
/** Validated bookkeeping metrics for Business Insights (SOW 28). Same department scope as the rest of the insights. */
export async function bookkeepingInsights({ orgId, departmentIds = null, from = null, to = null }) {
  const c = await getBookkeeperCollections(); const q = { ...scope(orgId, departmentIds), status: { $ne: "REVERSED" }, ...(from || to ? { date: { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) } } : {}) };
  const txns = await c.bkTransactions.find(q).project({ amount: 1, currency: 1, direction: 1, category: 1, status: 1, counterparty: 1, counterpartyKey: 1, anomalies: 1 }).limit(50000).toArray();
  if (!txns.length) return { available: false, reason: "No bank transactions have been imported yet." };
  const usd = (t) => { const r = comparableAmount(t.amount, t.currency, "USD"); return r.error ? null : r.amount; };
  let income = 0, expense = 0, skipped = 0; const cat = new Map(), sup = new Map();
  for (const t of txns) { const v = usd(t); if (v === null) { skipped++; continue; } if (t.direction === "CREDIT") income += v; else { expense += v; cat.set(t.category || "Uncategorized", (cat.get(t.category || "Uncategorized") || 0) + v); const k = t.counterparty || t.counterpartyKey || "Unknown"; sup.set(k, (sup.get(k) || 0) + v); } }
  const matched = txns.filter((t) => ["AUTO_MATCHED", "CONFIRMED", "RECONCILED"].includes(t.status)).length;
  const top = (m, n = 5) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, v]) => ({ name, amountUsd: Math.round(v * 100) / 100 }));
  return {
    available: true, currencyBasis: "USD via the platform's static, dated reference rates", transactions: txns.length, skippedUnconvertible: skipped,
    totalIncomeUsd: Math.round(income * 100) / 100, totalExpenseUsd: Math.round(expense * 100) / 100, categorizedSpend: top(cat, 8), supplierSpend: top(sup, 5),
    unmatchedTransactions: txns.filter((t) => ["UNMATCHED", "EXCEPTION"].includes(t.status)).length, reconciliationPercentage: pctOf(matched, txns.length),
    exceptionCount: await c.bkReviewItems.countDocuments({ ...scope(orgId, departmentIds), status: "OPEN" }), duplicateCount: await c.bkDocuments.countDocuments({ ...scope(orgId, departmentIds), status: "DUPLICATE" }),
    cashMovementUsd: Math.round((income - expense) * 100) / 100,
  };
}

// ------------------------------------------------------------------------------------------------------------------ observability
export async function observability({ orgId }) {
  const c = await getBookkeeperCollections(); const oid = toObjectId(orgId); const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const [docsProc, docsFailed, txnImported, txnCat, txnMatched, review, dup, anom, aiDocs, aiCats, srcFail, times] = await Promise.all([
    c.bkDocuments.countDocuments({ orgId: oid, createdAt: { $gte: since }, status: { $in: ["EXTRACTED", "PROCESSED", "NEEDS_REVIEW"] } }), c.bkDocuments.countDocuments({ orgId: oid, createdAt: { $gte: since }, status: "FAILED" }),
    c.bkTransactions.countDocuments({ orgId: oid, createdAt: { $gte: since } }), c.bkTransactions.countDocuments({ orgId: oid, createdAt: { $gte: since }, category: { $nin: [null, "Uncategorized"] } }), c.bkTransactions.countDocuments({ orgId: oid, createdAt: { $gte: since }, status: { $in: ["AUTO_MATCHED", "CONFIRMED", "RECONCILED"] } }),
    c.bkReviewItems.countDocuments({ orgId: oid, status: "OPEN" }), c.bkDocuments.countDocuments({ orgId: oid, createdAt: { $gte: since }, status: "DUPLICATE" }), c.bkTransactions.countDocuments({ orgId: oid, createdAt: { $gte: since }, "anomalies.0": { $exists: true } }),
    c.bkDocuments.countDocuments({ orgId: oid, createdAt: { $gte: since }, extractionMethod: /ai/ }), c.bkTransactions.countDocuments({ orgId: oid, createdAt: { $gte: since }, categoryMethod: "AI" }),
    c.bkSources.countDocuments({ orgId: oid, lastSyncStatus: "FAILED" }), c.bkTransactions.find({ orgId: oid, createdAt: { $gte: since }, processedAt: { $exists: true } }).project({ createdAt: 1, processedAt: 1 }).limit(2000).toArray(),
  ]);
  const ms = times.map((t) => Date.parse(t.processedAt) - Date.parse(t.createdAt)).filter((x) => x >= 0);
  return { windowDays: 30, documentsProcessed: docsProc, documentsFailed: docsFailed, transactionsImported: txnImported, transactionsCategorized: txnCat, transactionsMatched: txnMatched, reconciliationRate: pctOf(txnMatched, txnImported), reviewQueueSize: review, duplicateDetections: dup, anomalyDetections: anom, averageProcessingMs: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : null, aiUsage: { documentExtractions: aiDocs, categorizations: aiCats }, connectorFailures: srcFail, source: "computed from stored records only" };
}
