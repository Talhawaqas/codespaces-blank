// src/lib/documentAutomation/manifest.js
//
// Document Automation SOW §13/§14/§24 -- cryptographic document identity
// and the canonical manifest. Deliberately NOT a second audit system (§29):
// these are content fingerprints attached to one generatedDocuments record
// and verified by direct recomputation. The tamper-evident record of WHEN
// things happened lives in the org's real audit chain (auditChain.js, via
// logOrgActivity); the manifest only binds the document's own content:
//
//   documentHash      SHA-256 of the exact PDF bytes
//   sourceDataHash    canonical hash of the authorized source snapshot
//   templateHash      canonical hash of the template spec used
//   calculationHash   canonical hash of the integer minor-unit calculation
//   evidenceRoot      head of the document's evidence-node hash chain
//   manifestHash      canonical hash of everything above

import { createHash } from "node:crypto";

function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

/** Hashes a JS value deterministically -- keys sorted recursively so the
 *  same logical data always produces the same hash regardless of property
 *  insertion order. */
export function canonicalHash(value) {
  return sha256Hex(canonicalStringify(value));
}

export function canonicalStringify(value) {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object") {
    if (typeof value.toHexString === "function") return value.toHexString(); // ObjectId
    return Object.keys(value).sort().reduce((acc, key) => {
      if (value[key] !== undefined) acc[key] = sortKeysDeep(value[key]);
      return acc;
    }, {});
  }
  return value;
}

/** JSON round-trip: drops undefined, turns Dates into ISO strings. Everything
 *  that is hashed AND stored goes through this first, because the MongoDB
 *  driver stores `undefined` as `null` -- a structure hashed before storage
 *  would otherwise hash differently when re-read and re-verified. */
export function jsonSafe(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function hashDocumentBytes(buffer) {
  return sha256Hex(buffer);
}

export function calculationHashOf(calculationResult) {
  return canonicalHash(calculationResult?._minorUnits || calculationResult);
}

/** Builds the canonical manifest (SOW §14's shape, in this codebase's
 *  naming). Accepts either precomputed hashes or the raw inputs to derive
 *  them from, so callers that only have the calculation result still work. */
export function buildDocumentManifest({
  documentId, documentType, documentVersion, documentNumber, organizationId, locale,
  sourceRecords, sourceSnapshot, sourceDataHash, calculationResult, calculationHash,
  templateId, templateVersion, templateHash, renderer,
  documentHash, storageReference, approvalReference, evidenceRoot,
  createdAt, finalizedAt,
}) {
  const manifest = {
    schemaVersion: "1.0",
    documentId, documentType, documentVersion, documentNumber: documentNumber || null, organizationId, locale: locale || null,
    templateId, templateVersion, templateHash: templateHash || null,
    sourceRecords: (sourceRecords || []).map((r) => ({ type: r.type, id: String(r.id), version: r.version ?? null })),
    sourceDataHash: sourceDataHash || (sourceSnapshot !== undefined ? canonicalHash(sourceSnapshot) : canonicalHash(sourceRecords || [])),
    calculationHash: calculationHash || (calculationResult ? calculationHashOf(calculationResult) : null),
    documentHash,
    renderer: renderer || null,
    evidenceRoot: evidenceRoot || null,
    storageReference: storageReference || null,
    approvalReference: approvalReference || null,
    createdAt, finalizedAt: finalizedAt || null,
  };
  return { ...manifest, manifestHash: canonicalHash(manifest) };
}

/** Real verification, not a stored "verified: true" flag -- recomputes the
 *  document hash from the actual bytes and the calculation hash from the
 *  actual calculation result, and compares (§13: detect whether a later
 *  file is byte-identical to the finalized document). Also re-derives the
 *  manifestHash so an edited manifest is caught. */
export function verifyDocumentIntegrity({ manifest, documentBytes, calculationResult, templateSpec, sourceSnapshot }) {
  const actualDocumentHash = documentBytes ? hashDocumentBytes(documentBytes) : null;
  const actualCalculationHash = calculationResult ? calculationHashOf(calculationResult) : null;
  const actualTemplateHash = templateSpec ? canonicalHash(templateSpec) : null;
  const actualSourceDataHash = sourceSnapshot !== undefined ? canonicalHash(sourceSnapshot) : null;

  const documentHashMatches = actualDocumentHash === null ? null : actualDocumentHash === manifest.documentHash;
  const calculationHashMatches = actualCalculationHash === null ? null : actualCalculationHash === manifest.calculationHash;
  const templateHashMatches = actualTemplateHash === null ? null : actualTemplateHash === manifest.templateHash;
  const sourceDataHashMatches = actualSourceDataHash === null ? null : actualSourceDataHash === manifest.sourceDataHash;

  let manifestHashMatches = null;
  if (manifest.manifestHash) {
    const { manifestHash, ...rest } = manifest;
    manifestHashMatches = canonicalHash(rest) === manifestHash;
  }

  const checks = [documentHashMatches, calculationHashMatches, templateHashMatches, sourceDataHashMatches, manifestHashMatches];
  return {
    verified: checks.every((c) => c !== false),
    documentHashMatches, calculationHashMatches, templateHashMatches, sourceDataHashMatches, manifestHashMatches,
    actualDocumentHash, actualCalculationHash, actualTemplateHash, actualSourceDataHash,
  };
}
