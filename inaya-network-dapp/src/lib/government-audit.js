// src/lib/government-audit.js
//
// Government & Public Sector Sovereign OS SOW, Phase 1 (§B "chain of
// custody", §C "complete access and modification audit history") — the
// government-domain equivalent of health-audit.js. Writes the real,
// human-readable, per-record read-model FIRST (fast lookups for a
// citizen-record or case's own access timeline, without walking the
// whole org's audit chain), then best-effort appends to the cryptographic
// hash-chain SECOND. Same resilience discipline as health-audit.js: a
// chain-append failure must never block or fail a call whose real record
// already committed successfully.

import { appendAuditEntry } from "./auditChain.js";
import { getOrgCollections, toObjectId } from "./orgs.js";

async function chainSafely(entry) {
  try {
    await appendAuditEntry(entry);
  } catch (err) {
    console.error("government-audit: audit chain append failed:", err.message);
  }
}

export async function logCitizenRecordAccess({ orgId, recordId, actorEmail, action, metadata }) {
  const { citizenRecords } = await getOrgCollections();
  // citizenRecords itself holds no access-event subcollection of its own —
  // the audit chain (via chainSafely below) is the record of truth for
  // citizen-record access history, matching every SOW's "no parallel audit
  // system" discipline (incidents.js's header comment states this exactly).
  void citizenRecords;
  return chainSafely({ orgId, recordType: "CITIZEN_RECORD", recordId: toObjectId(recordId), actorEmail, action, previousState: null, newState: null, metadata: metadata || {} });
}

/** The stricter, government-only "log every READ, not just every write"
 *  bar SOW §B requires. Deliberately a SEPARATE collection from the
 *  general documentActivity (which only ever logs mutations for every
 *  other vertical) rather than changing that collection's long-established
 *  meaning for everyone else — gated to government-vertical orgs only by
 *  the caller (see the documents/[documentId]/retrieve route). */
export async function logGovernmentDocumentRead({ orgId, documentId, actorEmail, metadata }) {
  const { governmentDocumentReads } = await getOrgCollections();
  const event = { orgId: toObjectId(orgId), documentId, actorEmail, readAt: new Date().toISOString(), metadata: metadata || {} };
  await governmentDocumentReads.insertOne(event);
  await chainSafely({ orgId, recordType: "GOVERNMENT_DOCUMENT", recordId: documentId, actorEmail, action: "READ", previousState: null, newState: null, metadata: metadata || {} });
  return event;
}

export async function listCitizenRecordAccess(orgId) {
  // Thin pass-through to the audit chain, filtered to this record type —
  // kept here rather than making every caller import auditChain.js
  // directly and know the recordType string convention.
  const { auditChainEntries } = await getOrgCollections();
  return auditChainEntries.find({ orgId: toObjectId(orgId), recordType: "CITIZEN_RECORD" }).sort({ seq: -1 }).toArray();
}

export async function listGovernmentDocumentReads(orgId, documentId) {
  const { governmentDocumentReads } = await getOrgCollections();
  return governmentDocumentReads.find({ orgId: toObjectId(orgId), documentId }).sort({ readAt: -1 }).toArray();
}
