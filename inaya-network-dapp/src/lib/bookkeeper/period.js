// src/lib/bookkeeper/period.js
//
// AI Bookkeeper SOW section 27: an OPTIONAL period-close checklist. It scans a calendar month for the things a reviewer must clear
// (unmatched transactions, unpaid or unmatched invoices, duplicate candidates, open exceptions, transactions with no supporting document),
// produces a checklist, and lets a Finance Manager mark the period reviewed.
// This is a BOOKKEEPING REVIEW MARKER. It is NOT a statutory month-end close: Inaya has no general ledger, so nothing is locked or posted.

import { toObjectId } from "../orgs.js";
import { getBookkeeperCollections } from "./db.js";
import { fail, nowIso } from "./common.js";
import { audit, event, notify } from "./record.js";

const RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const monthRange = (period) => { const [y, m] = period.split("-").map(Number); const from = `${period}-01`; const last = new Date(Date.UTC(y, m, 0)).getUTCDate(); return { from, to: `${period}-${String(last).padStart(2, "0")}` }; };

export async function scanPeriod({ orgId, period, departmentIds = null }) {
  if (!RE.test(String(period))) return fail("period must be YYYY-MM.");
  const c = await getBookkeeperCollections(); const oid = toObjectId(orgId); const { from, to } = monthRange(period);
  const dept = departmentIds ? { departmentId: { $in: departmentIds } } : {};
  const dq = { orgId: oid, ...dept, date: { $gte: from, $lte: to } };
  const created = { $gte: `${from}T00:00:00Z`, $lte: `${to}T23:59:59Z` };
  const sample = (rows, f) => rows.slice(0, 10).map(f);
  const [unmatched, review, dups, txns, invoices] = await Promise.all([
    c.bkTransactions.find({ ...dq, status: { $in: ["UNMATCHED", "EXCEPTION", "HUMAN_REVIEW", "SUGGESTED"] } }).limit(2000).toArray(),
    c.bkReviewItems.find({ orgId: oid, ...dept, status: "OPEN", createdAt: created }).limit(2000).toArray(),
    c.bkDocuments.find({ orgId: oid, ...dept, status: "DUPLICATE", createdAt: created }).limit(2000).toArray(),
    c.bkTransactions.find({ ...dq, direction: "DEBIT", status: { $in: ["AUTO_MATCHED", "CONFIRMED", "RECONCILED"] } }).limit(5000).toArray(),
    c.invoices.find({ orgId: oid, ...dept, deletedAt: null, status: { $in: ["SENT", "OVERDUE"] }, issueDate: { $gte: from, $lte: `${to}T23:59:59Z` } }).limit(2000).toArray(),
  ]);
  const ids = txns.map((t) => t._id);
  const withDoc = new Set((ids.length ? await c.bkMatches.find({ orgId: oid, transactionId: { $in: ids }, targetKind: { $in: ["BK_DOCUMENT", "INVOICE"] }, status: { $in: ["AUTO_MATCHED", "CONFIRMED", "RECONCILED"] } }).project({ transactionId: 1 }).toArray() : []).map((m) => String(m.transactionId)));
  const noDoc = txns.filter((t) => !withDoc.has(String(t._id)));
  const checklist = [
    { key: "unmatched_transactions", label: "Bank transactions that are unmatched or waiting for review", count: unmatched.length, blocker: true, sample: sample(unmatched, (t) => ({ id: String(t._id), date: t.date, description: t.description, amount: t.amount, currency: t.currency, status: t.status })) },
    { key: "unpaid_invoices", label: "Customer invoices issued this month and still unpaid", count: invoices.length, blocker: false, sample: sample(invoices, (i) => ({ id: String(i._id), number: i.invoiceNumber, total: i.total, currency: i.currency, status: i.status })) },
    { key: "duplicate_candidates", label: "Documents flagged as duplicates", count: dups.length, blocker: false, sample: sample(dups, (d) => ({ id: String(d._id), invoiceNumber: d.fields?.invoiceNumber?.value, total: d.fields?.total?.value })) },
    { key: "open_exceptions", label: "Open review items and exceptions", count: review.length, blocker: true, sample: sample(review, (r) => ({ id: String(r._id), type: r.type, reason: r.reason })) },
    { key: "missing_documents", label: "Payments matched without a supporting document or invoice", count: noDoc.length, blocker: false, sample: sample(noDoc, (t) => ({ id: String(t._id), date: t.date, description: t.description, amount: t.amount })) },
  ].map((k) => ({ ...k, status: k.count ? (k.blocker ? "BLOCKING" : "ATTENTION") : "OK" }));
  const blocking = checklist.filter((k) => k.status === "BLOCKING").length;
  return { period, from, to, checklist, blocking, ready: blocking === 0, note: "Bookkeeping review only. This is not a statutory month-end close; Inaya has no general ledger to lock." };
}

export async function startPeriodClose({ orgId, period, departmentIds, actorEmail }) {
  const scan = await scanPeriod({ orgId, period, departmentIds }); if (scan.error) return scan;
  const { bkPeriods } = await getBookkeeperCollections();
  const cur = await bkPeriods.findOne({ orgId: toObjectId(orgId), period });
  if (cur?.status === "CLOSED") return fail(`${period} is already marked reviewed.`, 409);
  await bkPeriods.updateOne({ orgId: toObjectId(orgId), period }, { $set: { status: "IN_REVIEW", checklist: scan.checklist.map(({ sample, ...k }) => k), startedBy: actorEmail, startedAt: nowIso(), updatedAt: nowIso() }, $setOnInsert: { createdAt: nowIso() } }, { upsert: true });
  await event({ orgId, type: "PERIOD_CLOSE_STARTED", recordId: orgId, actorEmail, metadata: { period, blocking: scan.blocking } });
  if (scan.blocking) await notify({ orgId, title: `Period ${period} has ${scan.blocking} blocking item(s)`, body: "Clear the unmatched transactions and open exceptions before marking the period reviewed.", dedupeKey: `bk:period:${period}:${scan.blocking}`, severity: "warning" });
  return scan;
}

export async function completePeriodClose({ orgId, period, departmentIds, actorEmail, overrideNote = null }) {
  const scan = await scanPeriod({ orgId, period, departmentIds }); if (scan.error) return scan;
  if (scan.blocking && !(overrideNote && String(overrideNote).trim().length >= 10)) return fail("Blocking items remain. Clear them, or record a reason (at least 10 characters) to mark the period reviewed anyway.", 409, { reasonCode: "BLOCKING_ITEMS", checklist: scan.checklist });
  const { bkPeriods } = await getBookkeeperCollections();
  const r = await bkPeriods.updateOne({ orgId: toObjectId(orgId), period, status: "IN_REVIEW" }, { $set: { status: "CLOSED", closedBy: actorEmail, closedAt: nowIso(), overrideNote: overrideNote || null, blockingAtClose: scan.blocking, updatedAt: nowIso() } });
  if (!r.matchedCount) return fail("Start the period review first.", 409);
  await event({ orgId, type: "PERIOD_CLOSE_COMPLETED", recordId: orgId, actorEmail, metadata: { period, blockingAtClose: scan.blocking, override: !!overrideNote } });
  await audit({ orgId, action: "BOOKKEEPER_PERIOD_MARKED_REVIEWED", actorEmail, metadata: { period, blockingAtClose: scan.blocking } });
  return { closed: true, period, note: scan.note };
}

export async function listPeriods({ orgId }) { const { bkPeriods } = await getBookkeeperCollections(); return { periods: (await bkPeriods.find({ orgId: toObjectId(orgId) }).sort({ period: -1 }).limit(36).toArray()).map((p) => ({ period: p.period, status: p.status, startedBy: p.startedBy, closedBy: p.closedBy || null, closedAt: p.closedAt || null, blockingAtClose: p.blockingAtClose ?? null })) }; }
