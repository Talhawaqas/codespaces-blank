// src/lib/bookkeeper/review.js
//
// AI Bookkeeper SOW section 20: the finance review queue. Every item shows what the system saw and why it stopped; every reviewer action is
// permission-checked, applied through the same functions automation uses (never a side door), and audited with the reviewer's identity.
// Approving something HIGH risk needs a Finance Manager (or owner/admin). Corrections are learned as MAPPINGS, never rewritten into history.

import { toObjectId } from "../orgs.js";
import { canManageFinance, canAccessFinance, canAccessDepartment } from "../orgs.js";
import { getBookkeeperCollections } from "./db.js";
import { fail, nowIso, REVIEW_ACTIONS, parseAmount, parseDate, cents } from "./common.js";
import { getSettings } from "./settings.js";
import { validateExtraction } from "./extract.js";
import { documentView, getDocument, identityKeyOf } from "./documents.js";
import { confirmMatch, processTransaction, learnMapping } from "./reconcile.js";
import { audit, event, link, notify, financeAudience } from "./record.js";

const oidOf = (id) => { try { return toObjectId(id); } catch { return null; } };

export const txnView = (t) => ({
  transactionId: String(t._id), sourceId: String(t.sourceId), date: t.date, description: t.description, counterparty: t.counterparty || null, amount: t.amount, direction: t.direction, currency: t.currency, reference: t.reference || null,
  category: t.category || null, categoryConfidence: t.categoryConfidence ?? null, categoryMethod: t.categoryMethod || null, categoryReason: t.categoryReason || null, status: t.status, matchConfidence: t.matchConfidence ?? null, decision: t.decision || null, risk: t.risk || null,
  reasons: t.decisionReasons || [], anomalies: t.anomalies || [], source: t.source, departmentId: String(t.departmentId), createdAt: t.createdAt, processedAt: t.processedAt || null,
});
const itemView = (i, rec = null) => ({ itemId: String(i._id), type: i.type, reason: i.reason, severity: i.severity, status: i.status, recordKind: i.recordKind, recordId: String(i.recordId), confidence: i.confidence ?? null, detail: i.detail || null, assignedTo: i.assignedTo || null, waiting: !!i.waiting, deferredUntil: i.deferredUntil || null, createdAt: i.createdAt, resolvedBy: i.resolvedBy || null, resolvedAt: i.resolvedAt || null, resolution: i.resolution || null, ...(rec ? { record: rec } : {}) });

export async function listQueue({ orgId, departmentIds = null, status = "OPEN", type = null, severity = null, limit = 50, skip = 0, includeDeferred = false }) {
  const { bkReviewItems } = await getBookkeeperCollections();
  const q = { orgId: toObjectId(orgId) };
  if (status) q.status = status; if (type) q.type = type; if (severity) q.severity = severity;
  if (departmentIds) q.departmentId = { $in: departmentIds };
  if (!includeDeferred && status === "OPEN") q.$or = [{ deferredUntil: null }, { deferredUntil: { $exists: false } }, { deferredUntil: { $lte: nowIso() } }];
  const [rows, total] = await Promise.all([bkReviewItems.find(q).sort({ severity: 1, createdAt: -1 }).skip(Math.max(0, skip)).limit(Math.min(200, limit)).toArray(), bkReviewItems.countDocuments(q)]);
  return { total, items: rows.map((i) => itemView(i)) };
}

export async function getItem({ orgId, itemId }) {
  const id = oidOf(itemId); if (!id) return null;
  const c = await getBookkeeperCollections();
  const item = await c.bkReviewItems.findOne({ _id: id, orgId: toObjectId(orgId) }); if (!item) return null;
  let record = null;
  if (item.recordKind === "DOCUMENT") { const d = await getDocument({ orgId, documentId: item.recordId }); record = d ? documentView(d, { full: true }) : null; }
  if (item.recordKind === "TRANSACTION") {
    const t = await c.bkTransactions.findOne({ _id: item.recordId, orgId: toObjectId(orgId) });
    const matches = t ? await c.bkMatches.find({ orgId: toObjectId(orgId), transactionId: t._id, status: { $in: ["SUGGESTED", "AUTO_MATCHED", "CONFIRMED"] } }).toArray() : [];
    record = t ? { ...txnView(t), matches: matches.map((m) => ({ matchId: String(m._id), targetKind: m.targetKind, targetId: m.targetId, targetNumber: m.targetNumber, targetParty: m.targetParty, matchType: m.matchType, confidence: m.confidence, allocation: m.allocation, explanation: m.explanation, discrepancy: m.discrepancy, signals: m.signals, alternatives: m.alternatives, status: m.status })) } : null;
  }
  return { item, view: itemView(item, record) };
}

function gate({ item, membership, action }) {
  if (!canAccessFinance(membership)) return fail("You don't have finance access.", 403);
  if (!canAccessDepartment(membership, item.departmentId)) return fail("You don't have access to this department.", 403);
  const needsManager = (action === "approve" && (item.severity === "high" || item.detail?.requiresApproval)) || action === "merge";
  if (needsManager && !canManageFinance(membership)) return fail("This decision needs a Finance Manager or an owner/admin.", 403, { reasonCode: "MANAGER_REQUIRED" });
  return null;
}

async function resolve(orgId, item, actorEmail, resolution) {
  const { bkReviewItems } = await getBookkeeperCollections();
  await bkReviewItems.updateOne({ _id: item._id, status: "OPEN" }, { $set: { status: "RESOLVED", resolution, resolvedBy: actorEmail, resolvedAt: nowIso() } });
  await event({ orgId, type: "HUMAN_REVIEW_COMPLETED", recordId: item.recordId, actorEmail, metadata: { itemId: String(item._id), type: item.type, resolution: String(resolution).slice(0, 120), recordKind: item.recordKind } });
}

/** Applies human edits to a document's fields (source "human", confidence 1) and re-validates. Nothing is invented: only the given fields change. */
async function editDocument({ orgId, doc, patch, actorEmail }) {
  const c = await getBookkeeperCollections(); const f = JSON.parse(JSON.stringify(doc.fields || {})); const edits = [];
  const numeric = ["subtotal", "tax", "discount", "total"]; const dates = ["invoiceDate", "dueDate"]; const texts = ["vendor", "customer", "invoiceNumber", "currency", "purchaseOrderNumber", "paymentReference", "paymentTerms"];
  for (const [k, raw] of Object.entries(patch || {})) {
    let v;
    if (numeric.includes(k)) { v = parseAmount(raw); if (!Number.isFinite(v)) return fail(`${k} must be a number.`); }
    else if (dates.includes(k)) { v = parseDate(raw); if (!v) return fail(`${k} must be a date.`); }
    else if (texts.includes(k)) { v = String(raw ?? "").trim().slice(0, 160); if (!v) return fail(`${k} cannot be empty.`); if (k === "currency") { v = v.toUpperCase(); if (!/^[A-Z]{3}$/.test(v)) return fail("currency must be a 3-letter code."); } }
    else if (k === "documentType") continue;
    else return fail(`Unknown field ${k}.`);
    edits.push({ field: k, from: f[k]?.value ?? null, to: v }); f[k] = { value: v, confidence: 1, source: "human", editedBy: actorEmail, editedAt: nowIso(), location: null };
  }
  const docType = patch?.documentType || doc.documentType;
  const v = validateExtraction({ fields: f, lineItems: doc.lineItems || [], documentType: docType });
  await c.bkDocuments.updateOne({ _id: doc._id }, { $set: { fields: v.fields, checks: v.checks, missing: v.missing, extractionConfidence: v.extractionConfidence, documentType: docType, identityKey: identityKeyOf(v.fields), humanVerified: true, status: doc.status === "NEEDS_REVIEW" ? "EXTRACTED" : doc.status, updatedAt: nowIso() } });
  await audit({ orgId, recordId: doc._id, action: "BOOKKEEPER_DOCUMENT_EDITED", actorEmail, metadata: { documentId: String(doc._id), edits } });
  link({ orgId, subjectType: "BOOKKEEPING_DOCUMENT", subjectId: doc._id, type: "APPROVED_BY", targetType: "BK_REVIEW", targetId: doc._id, note: `fields corrected by ${actorEmail}: ${edits.map((e) => e.field).join(", ")}`.slice(0, 190) });
  return { edited: edits.length, extractionConfidence: v.extractionConfidence, missing: v.missing };
}

/**
 * One reviewer decision. body depends on the action:
 *   approve   { post?: boolean (default true for a match) }
 *   reject    { reason }
 *   edit      { fields: {...} }  (documents)  |  { category } (transactions)
 *   rematch   { targetKind, targetId }
 *   split     { allocations: [{ targetKind, targetId, amount }] }
 *   merge     { intoDocumentId }
 *   mark_duplicate { ofDocumentId? }
 *   request_document { note }   defer { until }   escalate { to?, note }
 */
export async function act({ orgId, itemId, action, body = {}, membership, actorEmail }) {
  if (!REVIEW_ACTIONS.includes(action)) return fail(`action must be one of ${REVIEW_ACTIONS.join(", ")}.`);
  const got = await getItem({ orgId, itemId }); if (!got) return fail("Review item not found.", 404);
  const item = got.item;
  if (item.status !== "OPEN") return fail("This item was already resolved.", 409);
  const g = gate({ item, membership, action }); if (g) return g;
  const c = await getBookkeeperCollections(); const oid = toObjectId(orgId);
  const doc = item.recordKind === "DOCUMENT" ? await c.bkDocuments.findOne({ _id: item.recordId, orgId: oid }) : null;
  const txn = item.recordKind === "TRANSACTION" ? await c.bkTransactions.findOne({ _id: item.recordId, orgId: oid }) : null;
  if (!doc && !txn) return fail("The record behind this item no longer exists.", 404);
  const settings = await getSettings(orgId);
  await audit({ orgId, recordId: item._id, action: `BOOKKEEPER_REVIEW_${action.toUpperCase()}`, actorEmail, metadata: { itemId: String(item._id), type: item.type, recordKind: item.recordKind, recordId: String(item.recordId) } });

  switch (action) {
    case "approve": {
      if (doc) {
        if (doc.status === "DUPLICATE") return fail("This document was flagged as a duplicate. Mark it as a duplicate, or edit it to make it distinct.", 409);
        await c.bkDocuments.updateOne({ _id: doc._id }, { $set: { humanVerified: true, status: doc.status === "NEEDS_REVIEW" ? "EXTRACTED" : doc.status, updatedAt: nowIso() } });
        link({ orgId, subjectType: "BOOKKEEPING_DOCUMENT", subjectId: doc._id, type: "APPROVED_BY", targetType: "BK_REVIEW", targetId: doc._id, note: `verified by ${actorEmail}` });
        await resolve(orgId, item, actorEmail, "document verified"); return { resolved: true };
      }
      if (item.type === "LOW_CONFIDENCE_CATEGORY") {
        if (!txn.category || txn.category === "Uncategorized") return fail("Choose a category first (edit).", 409);
        await c.bkTransactions.updateOne({ _id: txn._id }, { $set: { categoryMethod: "HUMAN", categoryConfidence: 1, updatedAt: nowIso() } });
        if (settings.learnFromReview) await learnMapping({ orgId, txn, category: txn.category, actorEmail });
        await resolve(orgId, item, actorEmail, "category approved"); return { resolved: true };
      }
      const r = await confirmMatch({ orgId, transactionId: txn._id, membership, actorEmail, post: body.post !== false, note: body.note || null });
      if (r.error) return r;
      if (txn.category && txn.category !== "Uncategorized" && txn.categoryMethod !== "HUMAN" && settings.learnFromReview) await learnMapping({ orgId, txn, category: txn.category, actorEmail });
      await resolve(orgId, item, actorEmail, "match confirmed"); return { resolved: true, ...r };
    }
    case "reject": {
      const reason = String(body.reason || "").trim().slice(0, 200); if (!reason) return fail("A reason is required to reject.");
      if (doc) { await c.bkDocuments.updateOne({ _id: doc._id }, { $set: { status: "REJECTED", rejectedReason: reason, updatedAt: nowIso() } }); await c.bkMatches.updateMany({ orgId: oid, targetKind: "BK_DOCUMENT", targetId: String(doc._id), status: "SUGGESTED" }, { $set: { status: "REJECTED" } }); }
      else { await c.bkMatches.updateMany({ orgId: oid, transactionId: txn._id, status: { $in: ["SUGGESTED", "AUTO_MATCHED"] } }, { $set: { status: "REJECTED", rejectedBy: actorEmail, updatedAt: nowIso() } }); await c.bkTransactions.updateOne({ _id: txn._id }, { $set: { status: "UNMATCHED", humanRejected: true, updatedAt: nowIso() } }); }
      await resolve(orgId, item, actorEmail, `rejected: ${reason}`); return { resolved: true };
    }
    case "edit": {
      if (doc) { const r = await editDocument({ orgId, doc, patch: body.fields, actorEmail }); if (r.error) return r; await resolve(orgId, item, actorEmail, "fields corrected"); return { resolved: true, ...r }; }
      const cat = String(body.category || "").trim(); if (!cat || !settings.categories.includes(cat)) return fail("category must be one of the configured categories.");
      await c.bkTransactions.updateOne({ _id: txn._id }, { $set: { category: cat, categoryConfidence: 1, categoryMethod: "HUMAN", categoryReason: `Set by ${actorEmail}`, updatedAt: nowIso() } });
      await event({ orgId, type: "TRANSACTION_CATEGORIZED", recordId: txn._id, actorEmail, metadata: { transactionId: String(txn._id), category: cat, confidence: 1, method: "HUMAN", previous: txn.category } });
      link({ orgId, subjectType: "BOOKKEEPING_TRANSACTION", subjectId: txn._id, type: "APPROVED_BY", targetType: "BK_REVIEW", targetId: txn._id, note: `category ${cat} set by ${actorEmail}` });
      if (settings.learnFromReview) await learnMapping({ orgId, txn: { ...txn, category: cat }, category: cat, actorEmail });
      if (item.type === "LOW_CONFIDENCE_CATEGORY") await resolve(orgId, item, actorEmail, `category set to ${cat}`);
      return { resolved: item.type === "LOW_CONFIDENCE_CATEGORY", category: cat };
    }
    case "rematch": case "split": {
      if (!txn) return fail("Only bank transactions can be re-matched.", 409);
      const allocs = action === "split" ? body.allocations : [{ targetKind: body.targetKind, targetId: body.targetId, amount: body.amount }];
      if (!Array.isArray(allocs) || !allocs.length || allocs.length > 10) return fail("Give 1-10 allocations.");
      let sum = 0; const rows = [];
      for (const a of allocs) {
        if (!["INVOICE", "BK_DOCUMENT", "EXPENSE"].includes(a.targetKind)) return fail("targetKind must be INVOICE, BK_DOCUMENT or EXPENSE.");
        const tid = oidOf(a.targetId); if (!tid) return fail("targetId is invalid.");
        const col = { INVOICE: c.invoices, BK_DOCUMENT: c.bkDocuments, EXPENSE: c.expenses }[a.targetKind]; const target = await col.findOne({ _id: tid, orgId: oid });
        if (!target) return fail("A target was not found in this organization.", 404);
        if (!canAccessDepartment(membership, target.departmentId)) return fail("You don't have access to a target's department.", 403);
        const amount = a.amount === undefined ? txn.amount : Number(a.amount); if (!(amount > 0)) return fail("Each allocation needs a positive amount.");
        sum += cents(amount);
        rows.push({ orgId: oid, departmentId: txn.departmentId, transactionId: txn._id, targetKind: a.targetKind, targetId: String(tid), targetNumber: target.invoiceNumber || target.fields?.invoiceNumber?.value || null, targetParty: target.vendor || target.fields?.vendor?.value || target.fields?.customer?.value || null, matchType: "MANUAL", confidence: 1, signals: { manual: true }, explanation: [`Chosen by ${actorEmail}.`], discrepancy: null, allocation: amount, currency: txn.currency, status: "SUGGESTED", decision: "REVIEW", reasons: ["Chosen by a person"], alternatives: [], createdAt: nowIso(), updatedAt: nowIso(), createdBy: actorEmail });
      }
      if (sum > cents(txn.amount) + 1) return fail("The allocations add up to more than the transaction.");
      await c.bkMatches.updateMany({ orgId: oid, transactionId: txn._id, status: { $in: ["SUGGESTED", "AUTO_MATCHED"] } }, { $set: { status: "REJECTED", rejectedBy: actorEmail, updatedAt: nowIso() } });
      await c.bkMatches.insertMany(rows);
      await c.bkTransactions.updateOne({ _id: txn._id }, { $set: { status: "SUGGESTED", humanRejected: false, updatedAt: nowIso() } });
      const r = await confirmMatch({ orgId, transactionId: txn._id, membership, actorEmail, post: body.post !== false });
      if (r.error) return r;
      await resolve(orgId, item, actorEmail, action === "split" ? "split and confirmed" : "re-matched and confirmed"); return { resolved: true, ...r };
    }
    case "merge": {
      if (!doc) return fail("Only documents can be merged.", 409);
      const into = await getDocument({ orgId, documentId: body.intoDocumentId }); if (!into) return fail("The document to merge into was not found.", 404);
      if (String(into._id) === String(doc._id)) return fail("A document cannot be merged into itself.");
      await c.bkDocuments.updateOne({ _id: doc._id }, { $set: { status: "DUPLICATE", duplicateOf: into._id, mergedInto: into._id, updatedAt: nowIso() } });
      await c.bkDocuments.updateOne({ _id: into._id }, { $push: { occurrences: { $each: [...(doc.occurrences || []), { at: nowIso(), channel: "MERGE", mergedFrom: String(doc._id) }] } }, $set: { updatedAt: nowIso() } });
      await resolve(orgId, item, actorEmail, "merged into another document"); return { resolved: true };
    }
    case "mark_duplicate": {
      if (doc) { const of = body.ofDocumentId ? oidOf(body.ofDocumentId) : doc.duplicateOf; await c.bkDocuments.updateOne({ _id: doc._id }, { $set: { status: "DUPLICATE", duplicateOf: of || null, updatedAt: nowIso() } }); }
      else await c.bkTransactions.updateOne({ _id: txn._id }, { $set: { status: "REVERSED", duplicateMarkedBy: actorEmail, updatedAt: nowIso() } });
      await event({ orgId, type: "DUPLICATE_DETECTED", recordId: item.recordId, actorEmail, metadata: { recordKind: item.recordKind, confirmedByHuman: true } });
      await resolve(orgId, item, actorEmail, "confirmed duplicate"); return { resolved: true };
    }
    case "request_document": {
      const note = String(body.note || "Supporting document requested").trim().slice(0, 200);
      await c.bkReviewItems.updateOne({ _id: item._id }, { $set: { waiting: true, waitingNote: note, updatedAt: nowIso() } });
      await notify({ orgId, title: "Supporting document requested", body: note, dedupeKey: `bk:reqdoc:${item._id}`, recordId: item._id });
      return { waiting: true };
    }
    case "defer": {
      const until = body.until ? new Date(body.until) : new Date(Date.now() + 3 * 86400000); if (Number.isNaN(until.getTime()) || until.getTime() <= Date.now() || until.getTime() > Date.now() + 90 * 86400000) return fail("until must be a future date within 90 days.");
      await c.bkReviewItems.updateOne({ _id: item._id }, { $set: { deferredUntil: until.toISOString() } }); return { deferredUntil: until.toISOString() };
    }
    case "escalate": {
      const to = body.to ? String(body.to).trim().toLowerCase() : (await financeAudience(orgId)).find((m) => m.email !== actorEmail)?.email;
      if (!to) return fail("There is nobody to escalate to.", 409);
      const target = await c.orgMembers.findOne({ orgId: oid, email: to, status: "active" }); if (!target || !(["owner", "admin"].includes(target.role) || target.financeRole === "manager")) return fail("Escalate to an owner, admin or Finance Manager.", 400);
      await c.bkReviewItems.updateOne({ _id: item._id }, { $set: { assignedTo: to, escalatedBy: actorEmail, escalatedAt: nowIso() } });
      await notify({ orgId, title: "Finance item escalated to you", body: String(body.note || item.reason).slice(0, 300), dedupeKey: `bk:esc:${item._id}:${to}`, severity: "warning", recordId: item._id });
      return { assignedTo: to };
    }
    default: return fail("Unsupported action.");
  }
}

void processTransaction;
