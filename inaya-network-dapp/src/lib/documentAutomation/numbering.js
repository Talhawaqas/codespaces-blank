// src/lib/documentAutomation/numbering.js
//
// Native Document & Invoice Automation Engine SOW, Section 6. The Phase
// 0 audit found no atomic sequence generator anywhere in this codebase
// -- the existing invoice route's own fallback is
// `INV-${Date.now().toString(36)}`, which is client-influenceable
// (invoiceNumber is an optional POST field) and not concurrency-safe
// (two requests in the same millisecond -- realistic under retry/double-
// click -- could theoretically collide, and nothing prevents an
// operator from typing in a duplicate). This is a genuine gap: real,
// server-side, atomic, org+type+year-scoped numbering for DOCUMENTS this
// engine finalizes (the underlying invoices collection's own
// invoiceNumber field is untouched by this module).
//
// Atomicity comes from MongoDB's single-document findOneAndUpdate with
// $inc being atomic per document -- the same primitive every real
// distributed counter uses, no separate lock needed.

import { getOrgCollections, toObjectId } from "../orgs.js";

const PREFIXES = {
  invoice: "INV",
  purchase_order: "PO",
  quotation: "QUO",
  sales_order: "SO",
  receipt: "RCT",
  statement: "STMT",
  credit_note: "CN",
  debit_note: "DN",
  delivery_note: "DEL",
  business_report: "RPT",
};

function sequenceKey(orgId, documentType, year) {
  return `${orgId}:${documentType}:${year}`;
}

/**
 * Atomically allocates the next number for (org, documentType, fiscal
 * year), formatted as e.g. "INV-2026-000001". Concurrency-safe: two
 * simultaneous calls always get two distinct, sequential numbers --
 * verified for real in documentAutomation.test.mjs by firing 20
 * concurrent allocations and asserting zero collisions, not just
 * asserted by code inspection.
 *
 * @param {Object} params
 * @param {string} params.orgId
 * @param {string} params.documentType - one of PREFIXES' keys
 * @param {number} [params.fiscalYear] - defaults to the current UTC year; callers with a non-calendar fiscal year pass their own
 */
export async function allocateDocumentNumber({ orgId, documentType, fiscalYear }) {
  const prefix = PREFIXES[documentType];
  if (!prefix) throw new Error(`Unknown document type "${documentType}" -- no numbering prefix configured.`);

  const year = fiscalYear || new Date().getUTCFullYear();
  const { documentSequences } = await getOrgCollections();
  const key = sequenceKey(orgId, documentType, year);

  const result = await documentSequences.findOneAndUpdate(
    { _id: key },
    { $inc: { seq: 1 }, $setOnInsert: { orgId: toObjectId(orgId), documentType, fiscalYear: year, createdAt: new Date().toISOString() } },
    { upsert: true, returnDocument: "after" }
  );

  const seq = result.seq;
  const padded = String(seq).padStart(6, "0");
  return { number: `${prefix}-${year}-${padded}`, sequence: seq, fiscalYear: year, prefix };
}

/** Read-only peek at the current sequence value, for admin/reporting --
 *  never used to allocate (that must always go through the atomic
 *  findOneAndUpdate above). */
export async function peekCurrentSequence({ orgId, documentType, fiscalYear }) {
  const year = fiscalYear || new Date().getUTCFullYear();
  const { documentSequences } = await getOrgCollections();
  const doc = await documentSequences.findOne({ _id: sequenceKey(orgId, documentType, year) });
  return { sequence: doc?.seq || 0, fiscalYear: year };
}

export const DOCUMENT_TYPE_PREFIXES = PREFIXES;
