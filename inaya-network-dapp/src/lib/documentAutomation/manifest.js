// src/lib/documentAutomation/manifest.js
//
// Native Document & Invoice Automation Engine SOW, Section 13/14. The
// canonical document manifest and its cryptographic fingerprints.
// Deliberately NOT a new hash-chain/audit system (SOW Section 29's "do
// not create a second audit subsystem") -- these hashes are content
// fingerprints attached to one generatedDocuments record, verified by
// direct recomputation (verifyDocumentIntegrity below), not chained to
// each other the way auditChain.js's tamper-evident log is. The actual
// tamper-evident record of WHEN this document was generated/approved/
// delivered lives in the real audit chain via logOrgActivity, called
// from generate.js/delivery.js -- this module only computes the
// document's own content hashes.

import { createHash } from "node:crypto";

function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

/** Hashes a JS value deterministically -- keys sorted recursively so the
 *  same logical data always produces the same hash regardless of
 *  property insertion order (a real, previously-seen risk class this
 *  session already hit once tonight with JSON key ordering). */
export function canonicalHash(value) {
  return sha256Hex(canonicalStringify(value));
}

export function canonicalStringify(value) {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = sortKeysDeep(value[key]);
      return acc;
    }, {});
  }
  return value;
}

export function hashDocumentBytes(buffer) {
  return sha256Hex(buffer);
}

/**
 * Builds the canonical manifest (SOW §14's exact shape, using this
 * codebase's own field-naming conventions).
 */
export function buildDocumentManifest({
  documentId, documentType, documentVersion, organizationId,
  sourceRecords, calculationResult, templateId, templateVersion,
  documentHash, storageReference, approvalReference, evidenceRoot,
  createdAt, finalizedAt,
}) {
  const calculationHash = canonicalHash(calculationResult._minorUnits || calculationResult);
  const sourceDataHash = canonicalHash(sourceRecords);

  return {
    documentId, documentType, documentVersion, organizationId,
    templateId, templateVersion,
    sourceRecords: sourceRecords.map((r) => ({ type: r.type, id: r.id, version: r.version ?? null })),
    sourceDataHash,
    calculationHash,
    documentHash,
    evidenceRoot: evidenceRoot || null,
    storageReference: storageReference || null,
    approvalReference: approvalReference || null,
    createdAt, finalizedAt: finalizedAt || null,
  };
}

/** Real verification, not a stored "verified: true" flag -- recomputes
 *  the document hash from the actual bytes and the calculation hash from
 *  the actual calculation result, and compares. SOW §13: "detect whether
 *  a later file is byte-identical to the finalized document." */
export function verifyDocumentIntegrity({ manifest, documentBytes, calculationResult }) {
  const actualDocumentHash = documentBytes ? hashDocumentBytes(documentBytes) : null;
  const actualCalculationHash = calculationResult ? canonicalHash(calculationResult._minorUnits || calculationResult) : null;

  const documentHashMatches = actualDocumentHash === null ? null : actualDocumentHash === manifest.documentHash;
  const calculationHashMatches = actualCalculationHash === null ? null : actualCalculationHash === manifest.calculationHash;

  return {
    verified: documentHashMatches !== false && calculationHashMatches !== false,
    documentHashMatches, calculationHashMatches,
    actualDocumentHash, actualCalculationHash,
  };
}
