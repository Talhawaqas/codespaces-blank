// src/lib/documentAutomation/verify.js
//
// Document Automation SOW §13/§19/§20/§36 -- verification and the Document
// Passport.
//
// Verification is real recomputation, never a stored flag:
//   - the document hash is recomputed from the actual bytes offered;
//   - the manifest hash, and the document's own evidence-node chain, are
//     recomputed from what is stored;
//   - the organization's audit chain (auditChain.js) is re-verified live;
//   - an authenticated check also reads the encrypted object back out of
//     storage and confirms it still hashes to the recorded value.
// An external verifier (recipient/auditor without an account) sees ONLY
// what §20 allows: id, type, version, finalized time, hash, approval status,
// evidence status -- never source records, amounts, customers or internal ids.
//
// The Document Passport is a portable, hash-sealed export that follows the
// existing Business Event Passport / evidence exporter convention
// (canonicalizeForExport + SHA-256 manifestHash + a PDF rendering), rather
// than a new export engine. Its scope is "internal" (an authorized viewer)
// or "external" (redacted to the §20 field set).

import { createHash } from "node:crypto";
import PDFDocument from "pdfkit";
import { getOrgCollections, toObjectId } from "../orgs.js";
import { verifyChainIntegrity } from "../auditChain.js";
import { canonicalizeForExport } from "../evidenceExporter.js";
import { logOrgActivity } from "../org-activity-log.js";
import { getDocumentType, canViewDocument } from "./documentTypes.js";
import { verifyEvidenceChain } from "./evidence.js";
import { verifyDocumentIntegrity, hashDocumentBytes, canonicalHash } from "./manifest.js";
import { readDocumentBytes } from "./storage.js";
import { recordEvidence } from "./evidence.js";
import { publicCalc } from "./pipeline.js";

const err = (error, status = 400, extra = {}) => ({ error, status, ...extra });
const APPROVAL_LABEL = (doc) => (doc.approval?.required ? (doc.approval.status === "APPROVED" ? "APPROVED" : doc.approval.status || "PENDING") : "NOT_REQUIRED");
const VALID_STATES = ["FINALIZED", "DELIVERED", "VIEWED", "PAID"];

function evidenceStatus(doc) {
  const chain = verifyEvidenceChain(doc.evidenceNodes || []);
  return { nodes: (doc.evidenceNodes || []).length, chainValid: chain.valid, head: chain.head || null, brokenAtSeq: chain.brokenAtSeq ?? null, pending: doc.pipelineState === "EVIDENCE_PENDING" };
}

// ---------------------------------------------------------------------
// Public (unauthenticated) verification
// ---------------------------------------------------------------------
function externalShape(doc, hashMatches) {
  const def = getDocumentType(doc.documentType);
  const ev = evidenceStatus(doc);
  return {
    found: true, documentId: String(doc._id), documentNumber: doc.documentNumber, documentType: def?.label || doc.documentType, documentVersion: doc.documentVersion,
    status: doc.status, isCurrent: VALID_STATES.includes(doc.status), finalizedAt: doc.finalizedAt || null, documentHash: doc.documentHash,
    approvalStatus: APPROVAL_LABEL(doc), evidenceStatus: ev.chainValid ? (ev.pending ? "PENDING" : "INTACT") : "BROKEN",
    storageVerified: doc.storageVerifiedAt ? { at: doc.storageVerifiedAt } : null,
    hashMatches,
    message: hashMatches === true ? "This file is byte-for-byte identical to the finalized document." : hashMatches === false ? "This file does NOT match the finalized document. It may have been altered or is a different document." : "Provide the file or its SHA-256 to check it against this record.",
  };
}

/** External verification by document id and/or file bytes/hash. Returns
 *  `found:false` (never an error) for an unknown id so ids can't be probed. */
export async function verifyPublic({ documentId, bytes, hash }) {
  const { generatedDocuments } = await getOrgCollections();
  let doc = null;
  const computed = bytes ? hashDocumentBytes(bytes) : (typeof hash === "string" && /^[0-9a-f]{64}$/i.test(hash) ? hash.toLowerCase() : null);
  if (documentId) {
    try { doc = await generatedDocuments.findOne({ _id: toObjectId(documentId), deletedAt: null }); } catch { doc = null; }
  }
  if (!doc && computed) doc = await generatedDocuments.findOne({ documentHash: computed, deletedAt: null });
  if (!doc || !doc.documentHash || !["FINALIZED", "DELIVERED", "VIEWED", "PAID", "SUPERSEDED", "VOID", "CANCELLED", "EXPIRED"].includes(doc.status)) {
    return { found: false, message: "No finalized document matches. Check the document ID or the file." };
  }
  const matches = computed ? computed === doc.documentHash : null;
  return externalShape(doc, matches);
}

// ---------------------------------------------------------------------
// Authenticated verification
// ---------------------------------------------------------------------
export async function verifyDocument({ orgId, documentId, bytes, deep = true, membership, email, actorEmail }) {
  const { generatedDocuments } = await getOrgCollections();
  let doc;
  try { doc = await generatedDocuments.findOne({ _id: toObjectId(documentId), orgId: toObjectId(orgId), deletedAt: null }); } catch { return err("Document not found.", 404); }
  if (!doc || !canViewDocument(membership, doc, email)) return err("Document not found.", 404);
  if (!doc.manifest) return err("This document has not been finalized, so it has no manifest to verify against.", 409);

  const integrity = verifyDocumentIntegrity({ manifest: doc.manifest, documentBytes: bytes || null, calculationResult: doc.calculation, templateSpec: doc.templateSpec, sourceSnapshot: doc.sourceSnapshot });
  const ev = evidenceStatus(doc);
  const audit = await verifyChainIntegrity(orgId).catch((e) => ({ valid: false, reason: e.message }));
  let storage = { checked: false };
  if (deep) {
    const stored = await readDocumentBytes({ orgId, storageReference: doc.storageReference, expectedHash: doc.documentHash });
    storage = stored.error ? { checked: true, ok: false, reason: stored.error } : { checked: true, ok: !!stored.hashMatches, actualHash: stored.actualHash };
    if (storage.ok) await generatedDocuments.updateOne({ _id: doc._id }, { $set: { storageVerifiedAt: new Date().toISOString() } });
  }
  const uploaded = bytes ? { provided: true, matches: integrity.documentHashMatches, actualHash: integrity.actualDocumentHash } : { provided: false };
  const verified = integrity.manifestHashMatches !== false && integrity.calculationHashMatches !== false && integrity.templateHashMatches !== false && integrity.sourceDataHashMatches !== false && ev.chainValid && audit.valid !== false && (storage.checked ? storage.ok : true) && (bytes ? integrity.documentHashMatches === true : true);
  await recordEvidence({ orgId, documentId: doc._id, nodeType: "VERIFICATION_RUN", actorEmail: actorEmail || email, actorType: "human", membership, gate: "view", data: { verified, uploadedFileChecked: !!bytes, uploadedMatches: uploaded.matches ?? null, storageOk: storage.ok ?? null }, logActivity: true });
  return {
    verification: {
      verified, documentId: String(doc._id), documentNumber: doc.documentNumber, documentVersion: doc.documentVersion, status: doc.status,
      manifestHashMatches: integrity.manifestHashMatches, calculationHashMatches: integrity.calculationHashMatches, templateHashMatches: integrity.templateHashMatches, sourceDataHashMatches: integrity.sourceDataHashMatches,
      uploadedFile: uploaded, storage, evidenceChain: ev, auditChain: { valid: audit.valid, entries: audit.count ?? null, reason: audit.reason || null },
      recordedDocumentHash: doc.documentHash,
    },
  };
}

// ---------------------------------------------------------------------
// Document Passport
// ---------------------------------------------------------------------
function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function buildPassportBody({ orgId, doc, scope }) {
  const { orgs, documentDeliveries, documentAccessEvents } = await getOrgCollections();
  const org = await orgs.findOne({ _id: toObjectId(orgId) });
  const def = getDocumentType(doc.documentType);
  const ev = evidenceStatus(doc);
  const audit = await verifyChainIntegrity(orgId).catch(() => null);
  const internal = scope === "internal";
  const deliveries = internal ? await documentDeliveries.find({ orgId: doc.orgId, documentId: doc._id }).sort({ createdAt: 1 }).toArray() : [];
  const access = internal ? await documentAccessEvents.find({ orgId: doc.orgId, documentId: doc._id }).sort({ at: 1 }).limit(500).toArray() : [];

  const body = {
    schemaVersion: "1.0", passportType: "DOCUMENT_PASSPORT", scope,
    document: {
      documentId: String(doc._id), documentNumber: doc.documentNumber, documentType: def?.label || doc.documentType, documentVersion: doc.documentVersion, status: doc.status,
      organization: internal ? (org?.name || null) : null, locale: doc.locale, pageCount: doc.pageCount, sizeBytes: doc.sizeBytes, createdAt: doc.createdAt, finalizedAt: doc.finalizedAt || null,
      supersededByDocumentId: doc.supersededByDocumentId ? String(doc.supersededByDocumentId) : null,
    },
    manifest: doc.manifest ? { ...doc.manifest, sourceRecords: internal ? doc.manifest.sourceRecords : undefined } : null,
    fingerprints: { documentHash: doc.documentHash, draftDocumentHash: doc.draftDocumentHash, sourceDataHash: doc.sourceDataHash, calculationHash: doc.calculationHash, templateHash: doc.templateHash, evidenceRoot: doc.manifest?.evidenceRoot || null, manifestHash: doc.manifest?.manifestHash || null },
    template: { templateId: doc.templateId, templateVersion: doc.templateVersion, name: doc.templateName },
    renderer: doc.manifest?.renderer || doc.renderer || null,
    calculation: internal && doc.calculation ? { currency: doc.currency, ...publicCalc(doc.calculation), lineItems: undefined } : { fingerprint: doc.calculationHash },
    approval: { required: !!doc.approval?.required, status: APPROVAL_LABEL(doc), ...(internal ? { requestedBy: doc.approval?.requestedByEmail || null, requestedAt: doc.approval?.requestedAt || null, decidedBy: doc.approval?.decidedByEmail || null, decidedAt: doc.approval?.decidedAt || null, decisionNote: doc.approval?.decisionNote || null, boundVersion: doc.approval?.boundVersion ?? null, boundDraftHash: doc.approval?.boundDocumentHash || null } : {}) },
    storage: { bucket: internal ? doc.storageReference?.bucket : undefined, key: internal ? doc.storageReference?.key : undefined, encryption: "server-managed AES-256-GCM, sharded across independent providers", retentionLock: true, lastVerifiedAt: doc.storageVerifiedAt || null },
    delivery: internal ? deliveries.map((d) => ({ mode: d.mode, recipient: d.recipientEmail, identityVerified: d.identityVerified, createdAt: d.createdAt, expiresAt: d.expiresAt, status: d.status, revokedAt: d.revokedAt || null, firstAccessAt: d.firstAccessAt || null, accessCount: d.accessCount || 0, documentVersion: d.documentVersion })) : undefined,
    accessHistory: internal ? access.map((a) => ({ type: a.type, result: a.result, at: a.at, mode: a.mode, recipient: a.recipientHint })) : undefined,
    evidenceGraph: { businessEventId: doc.businessEventId ? String(doc.businessEventId) : null, evidenceNodes: (doc.evidenceNodes || []).map((n) => ({ seq: n.seq, nodeType: n.nodeType, at: n.at, actorType: n.actor?.type, actor: internal ? n.actor?.email : undefined, dataHash: n.dataHash, prevNodeHash: n.prevNodeHash, nodeHash: n.nodeHash, auditRef: n.auditRef || null })) },
    verification: { evidenceChainValid: ev.chainValid, evidenceNodes: ev.nodes, evidenceHead: ev.head, auditChainIntact: audit ? audit.valid : null, auditChainEntriesChecked: audit?.count ?? null },
    proves: "Data -> Calculation -> Template -> Document -> Approval -> Storage -> Delivery",
    disclosure: internal
      ? "This passport documents evidence that already exists in Inaya's own records for this document. It is not a certification of compliance with any law, regulation or standard."
      : "External passport: source records, amounts, customers and internal identifiers are intentionally omitted. It proves the document's identity and provenance without exposing data beyond what its holder is authorized to see.",
  };
  return JSON.parse(JSON.stringify(body)); // drops undefined
}

export async function buildDocumentPassport({ orgId, documentId, scope = "internal", membership, email }) {
  if (!["internal", "external"].includes(scope)) return err('scope must be "internal" or "external".');
  const { generatedDocuments } = await getOrgCollections();
  let doc;
  try { doc = await generatedDocuments.findOne({ _id: toObjectId(documentId), orgId: toObjectId(orgId), deletedAt: null }); } catch { return err("Document not found.", 404); }
  if (!doc || !canViewDocument(membership, doc, email)) return err("Document not found.", 404);
  if (!doc.manifest) return err("Only a finalized document has a passport.", 409);
  const body = await buildPassportBody({ orgId, doc, scope });
  const manifestHash = sha256Hex(canonicalizeForExport(body));
  const passport = { ...body, manifestHash };
  await recordEvidence({ orgId, documentId: doc._id, nodeType: "PASSPORT_GENERATED", actorEmail: email, actorType: "human", membership, gate: "view", data: { manifestHash, scope }, logActivity: true });
  return { passport };
}

/** Independent verification of a passport (and optionally a PDF). */
export async function verifyDocumentPassport(passport, { bytes } = {}) {
  if (!passport || typeof passport !== "object") return { state: "INVALID", reason: "Not a valid passport object." };
  const { manifestHash, ...body } = passport;
  if (!manifestHash) return { state: "INCOMPLETE", reason: "Passport has no manifestHash to verify." };
  if (sha256Hex(canonicalizeForExport(body)) !== manifestHash) return { state: "INVALID", reason: "Manifest hash does not match passport content -- altered after generation." };
  const nodes = (body.evidenceGraph?.evidenceNodes || []);
  if (bytes && body.fingerprints?.documentHash && hashDocumentBytes(bytes) !== body.fingerprints.documentHash) return { state: "INVALID", reason: "The supplied file does not match the passport's document hash." };
  if (body.manifest?.manifestHash) {
    const { manifestHash: mh, ...rest } = body.manifest;
    if (canonicalHash(rest) !== mh) return { state: "INVALID", reason: "The embedded manifest was altered." };
  }
  const docId = body.document?.documentId;
  if (docId) {
    const { generatedDocuments } = await getOrgCollections();
    let live = null;
    try { live = await generatedDocuments.findOne({ _id: toObjectId(docId) }); } catch { live = null; }
    if (live) {
      if (live.documentHash !== body.fingerprints?.documentHash) return { state: "INVALID", reason: "The passport's document hash does not match the live record." };
      const chain = verifyEvidenceChain(live.evidenceNodes || []);
      if (!chain.valid) return { state: "INVALID", reason: `The document's evidence chain is broken at node ${chain.brokenAtSeq}.` };
      const audit = await verifyChainIntegrity(String(live.orgId)).catch(() => null);
      if (audit && !audit.valid) return { state: "INVALID", reason: `The organization's audit chain failed verification: ${audit.reason}` };
      return { state: "VERIFIED", manifestHash, evidenceNodesVerified: chain.count, documentStatus: live.status, isCurrent: VALID_STATES.includes(live.status) };
    }
  }
  return { state: "UNKNOWN", reason: "The passport is internally consistent but its document could not be found to cross-check.", nodes: nodes.length };
}

function heading(doc, text) {
  doc.moveDown(0.5).fontSize(13).fillColor("#0a5f6e").text(text);
  doc.fillColor("#000000").fontSize(9);
}
function kv(doc, label, value) {
  doc.fontSize(9).fillColor("#555555").text(`${label} `, { continued: true }).fillColor("#000000").text(String(value ?? "-"));
}

export function renderDocumentPassportPdf(passport) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, bufferPages: true, info: { Title: `Document Passport ${passport.document?.documentNumber || ""}`, CreationDate: new Date(0) } });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.fontSize(20).fillColor("#12161f").text("Inaya Document Passport");
    doc.moveDown(0.2).fontSize(9).fillColor("#777777").text(`${passport.scope === "external" ? "External (redacted)" : "Internal"} - portable evidence package, not a compliance certification.`);
    doc.fillColor("#000000");
    heading(doc, "Document");
    for (const [k, v] of Object.entries({ Number: passport.document.documentNumber, Type: passport.document.documentType, Version: passport.document.documentVersion, Status: passport.document.status, Finalized: passport.document.finalizedAt, Pages: passport.document.pageCount, Organization: passport.document.organization })) kv(doc, `${k}:`, v);
    heading(doc, "Fingerprints (SHA-256)");
    for (const [k, v] of Object.entries(passport.fingerprints)) if (v) doc.fontSize(7.5).font("Courier").fillColor("#000000").text(`${k}: ${v}`).font("Helvetica");
    heading(doc, "Approval");
    kv(doc, "Status:", passport.approval.status);
    if (passport.approval.decidedBy) { kv(doc, "Decided by:", passport.approval.decidedBy); kv(doc, "Decided at:", passport.approval.decidedAt); kv(doc, "Bound version:", passport.approval.boundVersion); }
    heading(doc, "Template and renderer");
    kv(doc, "Template:", `${passport.template.name || passport.template.templateId} v${passport.template.templateVersion}`);
    kv(doc, "Renderer:", passport.renderer ? `${passport.renderer.name} ${passport.renderer.version} (${passport.renderer.library} ${passport.renderer.libraryVersion})` : "-");
    heading(doc, "Storage");
    kv(doc, "Encryption:", passport.storage.encryption);
    kv(doc, "Last verified:", passport.storage.lastVerifiedAt);
    if (passport.delivery) {
      heading(doc, "Delivery and access");
      if (!passport.delivery.length) doc.text("No deliveries.");
      for (const d of passport.delivery) doc.fontSize(8).text(`${d.createdAt}  ${d.mode}  ${d.recipient || "(no recipient recorded)"}  ${d.status}  accesses: ${d.accessCount}`);
      for (const a of passport.accessHistory || []) doc.fontSize(8).fillColor("#444444").text(`   ${a.at}  ${a.type}  ${a.result}`).fillColor("#000000");
    }
    heading(doc, "Evidence chain");
    for (const n of passport.evidenceGraph.evidenceNodes) doc.fontSize(7.5).text(`#${n.seq} ${n.at}  ${n.nodeType} (${n.actorType})  ${String(n.nodeHash).slice(0, 16)}...`);
    heading(doc, "Verification");
    kv(doc, "Evidence chain valid:", passport.verification.evidenceChainValid ? "YES" : "NO");
    kv(doc, "Audit chain intact:", passport.verification.auditChainIntact === null ? "UNKNOWN" : passport.verification.auditChainIntact ? "YES" : "NO");
    kv(doc, "Proves:", passport.proves);
    heading(doc, "Passport integrity");
    doc.fontSize(8).font("Courier").text(`SHA-256: ${passport.manifestHash}`).font("Helvetica");
    doc.moveDown(1).fontSize(8).fillColor("#777777").text(passport.disclosure);
    doc.end();
  });
}

// ---------------------------------------------------------------------
// Authenticated download of the stored document (internal viewers)
// ---------------------------------------------------------------------
/** stage "final" (default) serves the finalized bytes; "draft" serves the
 *  exact version an approver looked at. Every download is evidence. */
export async function downloadDocumentBytes({ orgId, documentId, stage = "final", membership, email }) {
  const { generatedDocuments } = await getOrgCollections();
  let doc;
  try { doc = await generatedDocuments.findOne({ _id: toObjectId(documentId), orgId: toObjectId(orgId), deletedAt: null }); } catch { return err("Document not found.", 404); }
  if (!doc || !canViewDocument(membership, doc, email)) return err("Document not found.", 404);
  const ref = stage === "draft" ? (doc.draftStorageReference || doc.storageReference) : doc.storageReference;
  const expected = stage === "draft" ? doc.draftDocumentHash : doc.documentHash;
  if (!ref) return err("This document has no stored content yet.", 409);
  const bytes = await readDocumentBytes({ orgId, storageReference: ref, expectedHash: expected });
  if (bytes.error) return err(bytes.error, bytes.status || 502);
  if (!bytes.hashMatches) {
    await recordEvidence({ orgId, documentId: doc._id, nodeType: "INTEGRITY_FAILURE", actorEmail: "system", actorType: "system", data: { expected, actual: bytes.actualHash, stage: "internal-download" } });
    return err("The stored document failed its integrity check and was not released.", 500);
  }
  await recordEvidence({ orgId, documentId: doc._id, nodeType: "DOCUMENT_DOWNLOADED", actorEmail: email, actorType: "human", membership, gate: "view", data: { stage, documentHash: expected, internal: true } });
  return { buffer: bytes.buffer, filename: `${doc.documentNumber}${stage === "draft" ? "-draft" : ""}.pdf`, hash: expected };
}
