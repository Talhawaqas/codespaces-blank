// src/lib/documentAutomation/numbering.js
//
// Document Automation SOW §6 -- organization-scoped, document-type-scoped,
// concurrency-safe numbering with configurable prefixes, optional
// fiscal-year reset, an auditable allocation ledger and explicit handling
// of cancelled/voided numbers. The Phase 0 audit found no atomic sequence
// generator anywhere in the codebase (the invoice route's own fallback is
// `INV-${Date.now().toString(36)}` and its invoiceNumber is client-supplied).
//
// Atomicity: MongoDB's single-document findOneAndUpdate with $inc. A
// counter only ever moves forward, so a number is NEVER reused -- a
// cancelled or voided document keeps its number, recorded in the ledger
// with the reason, and the sequence continues. A unique (orgId, number)
// index on the ledger is a second, independent guard against duplicates.

import { getOrgCollections, toObjectId } from "../orgs.js";
import { getDocumentSettings, DEFAULT_PREFIXES } from "./settings.js";

export const DOCUMENT_TYPE_PREFIXES = DEFAULT_PREFIXES;
export const LEDGER_STATUSES = ["ALLOCATED", "ISSUED", "CANCELLED", "VOIDED", "FAILED"];

/** Fiscal-year label for a date. A calendar fiscal year (start month 1) is
 *  labelled by its year; otherwise by the calendar year in which it ENDS. */
export function fiscalYearFor(date, startMonth = 1) {
  const d = date ? new Date(date) : new Date();
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  if (startMonth === 1) return year;
  return month >= startMonth ? year + 1 : year;
}

function counterKey(orgId, documentType, resetKey) {
  return `${orgId}:${documentType}:${resetKey}`;
}

function formatNumber({ prefix, separator, fiscalYear, resetByYear, sequence, padding }) {
  const seq = String(sequence).padStart(padding, "0");
  return resetByYear ? `${prefix}${separator}${fiscalYear}${separator}${seq}` : `${prefix}${separator}${seq}`;
}

/**
 * Atomically allocates the next number and records it in the ledger.
 *
 * @param {Object} p
 * @param {string} p.orgId
 * @param {string} p.documentType
 * @param {number} [p.fiscalYear]  explicit override (tests / back-dated documents)
 * @param {string|Date} [p.issueDate] used to derive the fiscal year
 * @param {string} [p.allocatedBy]
 * @param {string|import("mongodb").ObjectId} [p.documentId] ledger back-reference
 * @param {Object} [p.settings]    pre-loaded settings (avoids a read)
 */
export async function allocateDocumentNumber({ orgId, documentType, fiscalYear, issueDate, allocatedBy = null, documentId = null, settings, prefixOverride }) {
  const cfg = settings || (await getDocumentSettings(orgId));
  const prefix = prefixOverride || cfg.numbering.prefixes[documentType];
  if (!prefix) throw new Error(`Unknown document type "${documentType}" -- no numbering prefix configured.`);

  const resetByYear = cfg.numbering.fiscalYearReset !== false;
  const year = fiscalYear || fiscalYearFor(issueDate, cfg.numbering.fiscalYearStartMonth || 1);
  const resetKey = resetByYear ? year : "ALL";
  const { documentSequences, documentNumberLedger } = await getOrgCollections();
  const key = counterKey(orgId, documentType, resetKey);

  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await documentSequences.findOneAndUpdate(
      { _id: key },
      { $inc: { seq: 1 }, $setOnInsert: { orgId: toObjectId(orgId), documentType, fiscalYear: resetByYear ? year : null, createdAt: new Date().toISOString() } },
      { upsert: true, returnDocument: "after" }
    );
    const sequence = result.seq;
    const number = formatNumber({ prefix, separator: cfg.numbering.separator || "-", fiscalYear: year, resetByYear, sequence, padding: cfg.numbering.padding || 6 });
    try {
      await documentNumberLedger.insertOne({
        orgId: toObjectId(orgId), documentType, fiscalYear: resetByYear ? year : null, sequence, number, prefix,
        status: "ALLOCATED", documentId: documentId ? toObjectId(documentId) : null,
        allocatedByEmail: allocatedBy, allocatedAt: new Date().toISOString(), statusChangedAt: null, statusReason: null,
      });
    } catch (err) {
      // A number already in the ledger (e.g. two types sharing a prefix
      // before validation existed) is never reused: burn this sequence value
      // and take the next one.
      if (err?.code === 11000) continue;
      throw err;
    }
    return { number, sequence, fiscalYear: resetByYear ? year : null, prefix };
  }
  throw new Error("Could not allocate a unique document number after several attempts.");
}

export async function setNumberStatus({ orgId, number, documentId, status, reason, actorEmail }) {
  if (!LEDGER_STATUSES.includes(status)) throw new Error(`Unknown ledger status "${status}".`);
  const { documentNumberLedger } = await getOrgCollections();
  const filter = { orgId: toObjectId(orgId) };
  if (number) filter.number = number; else if (documentId) filter.documentId = toObjectId(documentId); else throw new Error("number or documentId is required.");
  return documentNumberLedger.findOneAndUpdate(
    filter,
    { $set: { status, statusReason: reason || null, statusChangedAt: new Date().toISOString(), statusChangedByEmail: actorEmail || null } },
    { returnDocument: "after" }
  );
}

export async function attachDocumentToNumber({ orgId, number, documentId }) {
  const { documentNumberLedger } = await getOrgCollections();
  await documentNumberLedger.updateOne({ orgId: toObjectId(orgId), number }, { $set: { documentId: toObjectId(documentId) } });
}

export async function listNumberLedger({ orgId, documentType, fiscalYear, limit = 200 }) {
  const { documentNumberLedger } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId) };
  if (documentType) query.documentType = documentType;
  if (fiscalYear) query.fiscalYear = Number(fiscalYear);
  return documentNumberLedger.find(query).sort({ allocatedAt: -1 }).limit(Math.min(limit, 1000)).toArray();
}

/** Reports every sequence value that is not accounted for in the ledger
 *  (there should be none) alongside the ones explicitly cancelled/voided --
 *  the answer an auditor asks first about a numbered series. */
export async function numberSeriesReport({ orgId, documentType, fiscalYear }) {
  const { documentNumberLedger } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId), documentType };
  if (fiscalYear) query.fiscalYear = Number(fiscalYear);
  const rows = await documentNumberLedger.find(query).sort({ sequence: 1 }).toArray();
  const seen = new Set(rows.map((r) => r.sequence));
  const max = rows.length ? rows[rows.length - 1].sequence : 0;
  const unaccounted = [];
  for (let s = 1; s <= max; s++) if (!seen.has(s)) unaccounted.push(s);
  return {
    total: rows.length, highestSequence: max, unaccountedSequences: unaccounted,
    cancelled: rows.filter((r) => r.status === "CANCELLED").map((r) => ({ number: r.number, reason: r.statusReason })),
    voided: rows.filter((r) => r.status === "VOIDED").map((r) => ({ number: r.number, reason: r.statusReason })),
    failed: rows.filter((r) => r.status === "FAILED").map((r) => ({ number: r.number, reason: r.statusReason })),
  };
}

/** Read-only peek at the current counter -- never used to allocate. */
export async function peekCurrentSequence({ orgId, documentType, fiscalYear }) {
  const cfg = await getDocumentSettings(orgId);
  const resetByYear = cfg.numbering.fiscalYearReset !== false;
  const year = fiscalYear || fiscalYearFor(null, cfg.numbering.fiscalYearStartMonth || 1);
  const { documentSequences } = await getOrgCollections();
  const doc = await documentSequences.findOne({ _id: counterKey(orgId, documentType, resetByYear ? year : "ALL") });
  return { sequence: doc?.seq || 0, fiscalYear: resetByYear ? year : null };
}
