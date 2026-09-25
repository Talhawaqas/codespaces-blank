// src/lib/documentAutomation/lifecycle.js
//
// Document Automation SOW §9/§10/§23/§25 -- the document lifecycle, human
// approval and finalization.
//
// This does NOT add a second workflow engine (§9/§10). It uses the same
// idioms every existing workflow in this codebase uses: a transition table
// enforced by an atomic status-guarded findOneAndUpdate (replay-safe: a
// double click or a concurrent approval can only win once), the existing
// permission gates (canManageFinance / canManageOrg, chosen per document
// type in documentTypes.js), the existing Segregation-of-Duties checker
// (segregation-of-duties.js) for "no self-approval", and the existing
// notification + audit-chain infrastructure.
//
//   DRAFT -> GENERATED -> PENDING_APPROVAL -> APPROVED -> FINALIZED
//                 |              |               |            |
//                 |              +-> REJECTED    +-> CANCELLED +-> DELIVERED -> VIEWED -> PAID
//                 +-> FINALIZED (no approval required)              (+ VOID, CANCELLED, EXPIRED, SUPERSEDED)
//
// Approval binds to the EXACT version: the request records the version and
// the hashes of the document bytes, source snapshot, calculation and
// template. An approver sees the calculations, the source snapshot and what
// changed from the previous version; approval is refused if the version has
// been superseded, if the source data has changed since generation, or if
// the requester is the approver (when the org's SoD rule is enabled).
// Automation -- including AI -- can never approve: only a human actor is
// accepted here.

import { getOrgCollections, toObjectId } from "../orgs.js";
import { checkSodViolation } from "../segregation-of-duties.js";
import { syncBusinessEventStatus } from "../businessEvents.js";
import { getDocumentType, canViewDocument } from "./documentTypes.js";
import { prepare, renderStage, serializeDocument, publicCalc, supersedeInFlight, appBaseUrl, ACTIVE_FINAL_STATES, IN_FLIGHT_STATES } from "./pipeline.js";
import { recordEvidence, linkEvidenceGraph, addDocumentRelationship, evidenceRootAt } from "./evidence.js";
import { readDocumentBytes, storeDocumentBytes, documentKey, lockFinalizedObject } from "./storage.js";
import { buildDocumentManifest, hashDocumentBytes } from "./manifest.js";
import { setNumberStatus } from "./numbering.js";
import { getDocumentSettings } from "./settings.js";
import { notifyApprovers, notifyDecision, notifyUser } from "./notify.js";
import { recordMetric } from "./metrics.js";
import { revokeAllDeliveries } from "./delivery.js";

const err = (error, status = 400, extra = {}) => ({ error, status, ...extra });

export const TRANSITIONS = {
  requestApproval: { from: ["GENERATED"], to: "PENDING_APPROVAL" },
  approve: { from: ["PENDING_APPROVAL"], to: "APPROVED" },
  reject: { from: ["PENDING_APPROVAL"], to: "REJECTED" },
  finalizeDirect: { from: ["GENERATED"], to: "FINALIZED" },
  finalizeApproved: { from: ["APPROVED"], to: "FINALIZED" },
  cancel: { from: ["DRAFT", "GENERATED", "PENDING_APPROVAL", "APPROVED", "REJECTED"], to: "CANCELLED" },
  void: { from: ["FINALIZED", "DELIVERED", "VIEWED", "PAID"], to: "VOID" },
};

async function loadDoc({ orgId, documentId, membership, email }) {
  let _id;
  try { _id = toObjectId(documentId); } catch { return err("Document not found.", 404); }
  const { generatedDocuments } = await getOrgCollections();
  const doc = await generatedDocuments.findOne({ _id, orgId: toObjectId(orgId), deletedAt: null });
  if (!doc || !canViewDocument(membership, doc, email)) return err("Document not found.", 404);
  return { doc, def: getDocumentType(doc.documentType), collection: generatedDocuments };
}

// ---------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------
export async function requestApproval({ orgId, documentId, note, membership, email, actorType = "human" }) {
  const loaded = await loadDoc({ orgId, documentId, membership, email });
  if (loaded.error) return loaded;
  const { doc, def, collection } = loaded;
  if (!def.canGenerate(membership)) return err("You don't have permission to request approval for this document.", 403);
  if (!doc.approval?.required) return err("This document does not require approval; it can be finalized directly.", 409);
  if (!doc.storageReference || ["GENERATING", "GENERATION_FAILED", "STORAGE_FAILED", "STORAGE_PENDING"].includes(doc.pipelineState)) return err(`This document is not ready for approval (${doc.pipelineState}).`, 409);

  const settings = await getDocumentSettings(orgId);
  const now = new Date();
  const updated = await collection.findOneAndUpdate(
    { _id: doc._id, orgId: doc.orgId, status: "GENERATED", "approval.status": null },
    { $set: {
      status: "PENDING_APPROVAL", updatedAt: now.toISOString(),
      "approval.status": "PENDING", "approval.requestedByEmail": email, "approval.requestedByActorType": actorType, "approval.requestedAt": now.toISOString(), "approval.note": note ? String(note).slice(0, 500) : null,
      "approval.expiresAt": new Date(now.getTime() + settings.approval.staleAfterDays * 86400000).toISOString(),
      "approval.boundVersion": doc.documentVersion, "approval.boundDocumentHash": doc.draftDocumentHash, "approval.boundSourceDataHash": doc.sourceDataHash,
      "approval.boundCalculationHash": doc.calculationHash, "approval.boundTemplateHash": doc.templateHash,
    } },
    { returnDocument: "after" }
  );
  if (!updated) return err(`This document is ${doc.status} and cannot be submitted for approval.`, 409);

  await recordEvidence({ orgId, documentId: doc._id, nodeType: "APPROVAL_REQUESTED", actorEmail: email, actorType, membership, gate: "generate", data: { boundVersion: doc.documentVersion, boundDocumentHash: doc.draftDocumentHash, reason: doc.approval.reason || null }, previousState: "GENERATED", newState: "PENDING_APPROVAL" });
  const notified = await notifyApprovers({ orgId, doc: updated, finance: def.finance, requesterEmail: email }).catch(() => 0);
  return { document: serializeDocument(updated), notifiedApprovers: notified };
}

function diffAgainstPrevious(doc, previous) {
  if (!previous) return { previousVersion: null };
  const before = (previous.calculation?.lineItems || []).map((l) => l.description);
  const after = (doc.calculation?.lineItems || []).map((l) => l.description);
  return {
    previousVersion: previous.documentVersion, previousStatus: previous.status,
    grandTotal: { from: previous.grandTotal, to: doc.grandTotal, changed: previous.grandTotal !== doc.grandTotal },
    sourceDataChanged: previous.sourceDataHash !== doc.sourceDataHash,
    calculationChanged: previous.calculationHash !== doc.calculationHash,
    templateChanged: previous.templateHash !== doc.templateHash,
    linesAdded: after.filter((d) => !before.includes(d)), linesRemoved: before.filter((d) => !after.includes(d)),
  };
}

/** Everything an approver needs to approve THIS exact version (§10). */
export async function getApprovalPackage({ orgId, documentId, membership, email }) {
  const loaded = await loadDoc({ orgId, documentId, membership, email });
  if (loaded.error) return loaded;
  const { doc, def, collection } = loaded;
  const previous = await collection.find({ orgId: doc.orgId, seriesKey: doc.seriesKey, documentVersion: { $lt: doc.documentVersion } }).sort({ documentVersion: -1 }).limit(1).next();

  let drift = { checked: false, drifted: null, reason: "Source drift is checked when the version is approved." };
  if (["PENDING_APPROVAL", "GENERATED", "APPROVED"].includes(doc.status)) {
    const prep = await prepare({ orgId, documentType: doc.documentType, sourceId: doc.sourceRecordId ? String(doc.sourceRecordId) : (doc.options?.period || doc.seriesKey.split(":")[3]), options: doc.options || {}, templateId: doc.templateId, templateVersion: doc.templateVersion, locale: doc.locale, pageSize: doc.pageSize, membership, email, allowDraftTemplate: true });
    if (prep.error) drift = { checked: false, drifted: null, reason: prep.error };
    else drift = { checked: true, drifted: prep.sourceDataHash !== doc.sourceDataHash || prep.calculationHash !== doc.calculationHash, currentSourceDataHash: prep.sourceDataHash, currentCalculationHash: prep.calculationHash };
  }
  return {
    package: {
      document: serializeDocument(doc, { detail: true }),
      calculation: doc.calculation ? publicCalc(doc.calculation) : null,
      validationChecks: doc.validation?.checks || [],
      sourceSnapshot: doc.sourceSnapshot, sourceRecords: doc.sourceRecords,
      template: { templateId: doc.templateId, version: doc.templateVersion, name: doc.templateName, specHash: doc.templateHash },
      changesFromPreviousVersion: diffAgainstPrevious(doc, previous),
      drift,
      canApprove: def.canApprove(membership),
      approvalBinding: { boundVersion: doc.approval?.boundVersion ?? doc.documentVersion, boundDocumentHash: doc.approval?.boundDocumentHash || doc.draftDocumentHash, boundSourceDataHash: doc.approval?.boundSourceDataHash || doc.sourceDataHash },
    },
  };
}

export async function decideApproval({ orgId, documentId, decision, note, membership, email, actorType = "human" }) {
  if (!["approve", "reject"].includes(decision)) return err('decision must be "approve" or "reject".');
  if (actorType !== "human") return err("Only a human can approve or reject a document; automation and AI can never approve.", 403);
  const loaded = await loadDoc({ orgId, documentId, membership, email });
  if (loaded.error) return loaded;
  const { doc, def, collection } = loaded;
  if (!def.canApprove(membership)) return err("You don't have permission to approve this type of document.", 403);
  if (doc.status !== "PENDING_APPROVAL" || doc.approval?.status !== "PENDING") return err(`This document is ${doc.status}; only a version pending approval can be decided.`, 409);
  if (doc.approval.boundVersion !== doc.documentVersion || doc.approval.boundDocumentHash !== doc.draftDocumentHash) return err("This approval request no longer matches the document version.", 409);
  if (doc.approval.expiresAt && new Date(doc.approval.expiresAt) < new Date()) return err("This approval request has expired. Generate and submit a fresh version.", 409);

  // Newer versions exist? Approving a stale version is never allowed.
  const newer = await collection.findOne({ orgId: doc.orgId, seriesKey: doc.seriesKey, documentVersion: { $gt: doc.documentVersion }, status: { $nin: ["CANCELLED", "REJECTED", "SUPERSEDED", "EXPIRED", "VOID"] } });
  if (newer) return err(`Version ${newer.documentVersion} exists; version ${doc.documentVersion} is stale and cannot be approved.`, 409);

  if (decision === "approve") {
    for (const subject of [doc.approval.requestedByEmail, doc.createdByEmail]) {
      const sod = await checkSodViolation({ orgId, ruleType: def.sodRule, actorEmail: email, subjectEmail: subject });
      if (sod.violation) return err("Segregation of duties: you cannot approve a document you generated or requested approval for.", 403, { sod: true });
    }
    // The source must still be exactly what this version was generated from.
    const prep = await prepare({ orgId, documentType: doc.documentType, sourceId: doc.sourceRecordId ? String(doc.sourceRecordId) : (doc.options?.period || doc.seriesKey.split(":")[3]), options: doc.options || {}, templateId: doc.templateId, templateVersion: doc.templateVersion, locale: doc.locale, pageSize: doc.pageSize, membership, email, allowDraftTemplate: true });
    if (prep.error) return err(`The source data could not be re-checked: ${prep.error}`, 409, { stale: true });
    if (prep.sourceDataHash !== doc.approval.boundSourceDataHash || prep.calculationHash !== doc.approval.boundCalculationHash) return err("The source data has changed since this version was generated, so it cannot be approved. Regenerate the document.", 409, { stale: true });
  }

  const now = new Date().toISOString();
  const newStatus = decision === "approve" ? "APPROVED" : "REJECTED";
  const updated = await collection.findOneAndUpdate(
    { _id: doc._id, orgId: doc.orgId, status: "PENDING_APPROVAL", "approval.status": "PENDING", draftDocumentHash: doc.approval.boundDocumentHash },
    { $set: { status: newStatus, updatedAt: now, "approval.status": newStatus, "approval.decidedByEmail": email, "approval.decidedActorType": actorType, "approval.decidedAt": now, "approval.decisionNote": note ? String(note).slice(0, 500) : null } },
    { returnDocument: "after" }
  );
  if (!updated) return err("This document was already decided by someone else.", 409);

  await recordEvidence({ orgId, documentId: doc._id, nodeType: decision === "approve" ? "APPROVAL_GRANTED" : "APPROVAL_REJECTED", actorEmail: email, actorType, membership, gate: def.finance ? "canManageFinance" : "canManageOrg", data: { decision: newStatus, boundVersion: doc.approval.boundVersion, boundDocumentHash: doc.approval.boundDocumentHash, boundSourceDataHash: doc.approval.boundSourceDataHash, requestedBy: doc.approval.requestedByEmail }, previousState: "PENDING_APPROVAL", newState: newStatus });
  await notifyDecision({ orgId, doc: updated, decision: newStatus, actorEmail: email }).catch(() => {});
  return { document: serializeDocument(updated) };
}

// ---------------------------------------------------------------------
// Finalize
// ---------------------------------------------------------------------
export async function finalizeDocument({ orgId, documentId, membership, email, actorType = "human" }) {
  const t0 = Date.now();
  if (actorType !== "human") return err("Finalization requires a human actor.", 403);
  const loaded = await loadDoc({ orgId, documentId, membership, email });
  if (loaded.error) return loaded;
  const { doc, def, collection } = loaded;
  if (!def.canApprove(membership)) return err("You don't have permission to finalize this type of document.", 403);

  const needed = doc.approval?.required ? "APPROVED" : "GENERATED";
  if (doc.status !== needed) return err(doc.approval?.required && doc.status === "GENERATED" ? "This document requires approval before it can be finalized." : `This document is ${doc.status}; it must be ${needed} to finalize.`, 409);
  if (doc.pipelineState && !["COMPLETE", "EVIDENCE_PENDING"].includes(doc.pipelineState)) return err(`This document is not ready to finalize (${doc.pipelineState}).`, 409);
  if (doc.approval?.required && (doc.approval.boundDocumentHash !== doc.draftDocumentHash || doc.approval.decidedActorType !== "human")) return err("The approval does not match this version.", 409);

  // Atomic claim: only one finalizer can win.
  const claimed = await collection.findOneAndUpdate({ _id: doc._id, orgId: doc.orgId, status: needed, pipelineState: { $in: ["COMPLETE", "EVIDENCE_PENDING"] } }, { $set: { pipelineState: "FINALIZING", updatedAt: new Date().toISOString() } }, { returnDocument: "after" });
  if (!claimed) return err("This document is already being finalized.", 409);

  const fail = async (message, stage = "storage", state = "STORAGE_FAILED") => {
    await collection.updateOne({ _id: doc._id }, { $set: { pipelineState: state, failureStage: stage, failureReason: String(message).slice(0, 400) } });
    await recordEvidence({ orgId, documentId: doc._id, nodeType: "FINALIZATION_FAILED", actorEmail: email, actorType: "system", data: { stage, reason: String(message).slice(0, 300) } });
    return err(`Finalization failed: ${message}`, 502, { documentId: String(doc._id), pipelineState: state });
  };

  // 1. The stored draft bytes must still be exactly what was approved.
  const draft = await readDocumentBytes({ orgId, storageReference: doc.draftStorageReference || doc.storageReference, expectedHash: doc.draftDocumentHash });
  if (draft.error) return fail(draft.error);
  if (!draft.hashMatches) return fail("The stored document no longer matches its recorded fingerprint (integrity check failed).", "integrity", "STORAGE_FAILED");

  // 2. Re-render with the approval stamp when approval was required.
  let finalHash = doc.draftDocumentHash;
  let finalRef = doc.draftStorageReference || doc.storageReference;
  let finalBytes = draft.buffer;
  let pageCount = doc.pageCount;
  if (doc.approval?.required) {
    let rendered;
    try {
      rendered = await renderStage({ doc, renderInput: doc.renderInput, calc: doc.calculation, stage: "final", approval: { required: true, status: "APPROVED", decidedByEmail: doc.approval.decidedByEmail, decidedAt: doc.approval.decidedAt } });
    } catch (e) {
      return fail(e.message, "render", "GENERATION_FAILED");
    }
    finalBytes = rendered.buffer; finalHash = hashDocumentBytes(finalBytes); pageCount = rendered.pages;
    try {
      const stored = await storeDocumentBytes({ orgId, key: documentKey({ documentType: doc.documentType, documentId: doc._id, version: doc.documentVersion, number: doc.documentNumber, stage: "final" }), bytes: finalBytes, actorEmail: email, tags: { documentType: doc.documentType, documentId: String(doc._id), stage: "final" } });
      finalRef = { bucket: stored.bucket, key: stored.key, objectId: stored.objectId, versionId: stored.versionId, contentSha256: stored.contentSha256 };
    } catch (e) {
      return fail(e.message);
    }
  }

  // 3. Manifest, with the evidence root as it stands BEFORE finalization.
  const settings = await getDocumentSettings(orgId);
  const fresh = await collection.findOne({ _id: doc._id });
  const rootBefore = evidenceRootAt(fresh.evidenceNodes || [], fresh.evidenceSeq);
  const now = new Date().toISOString();
  const manifest = buildDocumentManifest({
    documentId: String(doc._id), documentType: doc.documentType, documentVersion: doc.documentVersion, documentNumber: doc.documentNumber, organizationId: String(orgId), locale: doc.locale,
    sourceRecords: doc.sourceRecords, sourceDataHash: doc.sourceDataHash, calculationHash: doc.calculationHash,
    templateId: doc.templateId, templateVersion: doc.templateVersion, templateHash: doc.templateHash,
    renderer: { name: doc.renderer?.name, version: doc.renderer?.version, library: doc.renderer?.library, libraryVersion: doc.renderer?.libraryVersion, fonts: doc.renderer?.fonts, runtime: doc.renderer?.runtime },
    documentHash: finalHash, storageReference: { bucket: finalRef.bucket, key: finalRef.key, versionId: finalRef.versionId },
    approvalReference: doc.approval?.required ? { status: "APPROVED", approvedBy: doc.approval.decidedByEmail, approvedAt: doc.approval.decidedAt, boundVersion: doc.approval.boundVersion, boundDraftHash: doc.approval.boundDocumentHash, requestedBy: doc.approval.requestedByEmail } : { status: "NOT_REQUIRED", reason: doc.approval?.reason || null, finalizedBy: email },
    evidenceRoot: rootBefore, createdAt: doc.createdAt, finalizedAt: now,
  });

  const updated = await collection.findOneAndUpdate(
    { _id: doc._id, orgId: doc.orgId, status: needed, pipelineState: "FINALIZING" },
    { $set: { status: "FINALIZED", pipelineState: "COMPLETE", documentHash: finalHash, storageReference: finalRef, sizeBytes: finalBytes.length, pageCount, manifest, manifestHash: manifest.manifestHash, finalizedAt: now, finalizedByEmail: email, updatedAt: now, failureReason: null, failureStage: null, searchText: `${doc.searchText || ""}`.replace(/\bGENERATED\b/, "FINALIZED") } },
    { returnDocument: "after" }
  );
  if (!updated) return err("This document changed while it was being finalized.", 409);

  await recordEvidence({ orgId, documentId: doc._id, nodeType: "DOCUMENT_FINALIZED", actorEmail: email, actorType, membership, gate: def.finance ? "canManageFinance" : "canManageOrg", data: { documentHash: finalHash, manifestHash: manifest.manifestHash, evidenceRoot: rootBefore, approval: manifest.approvalReference?.status }, previousState: needed, newState: "FINALIZED" });
  if (doc.approval?.required) await recordEvidence({ orgId, documentId: doc._id, nodeType: "STORAGE_COMPLETED", actorEmail: email, actorType: "system", data: { documentHash: finalHash, storageKey: finalRef.key, stage: "final" }, logActivity: true });

  // 4. Retention lock (immutability at the storage layer).
  const lock = await lockFinalizedObject({ orgId, storageReference: finalRef, retentionDays: settings.retention.finalizedRetentionDays, lockMode: settings.retention.lockMode, actorEmail: email });
  if (doc.approval?.required && (doc.draftStorageReference?.key !== finalRef.key)) await lockFinalizedObject({ orgId, storageReference: doc.draftStorageReference, retentionDays: settings.retention.finalizedRetentionDays, lockMode: settings.retention.lockMode, actorEmail: email }).catch(() => {});
  await recordEvidence({ orgId, documentId: doc._id, nodeType: "RETENTION_LOCK", actorEmail: email, actorType: "system", data: { locked: lock.locked, retentionUntil: lock.retentionUntil || null, lockMode: lock.lockMode || null, reason: lock.reason || null }, logActivity: false });

  // 5. Supersede older finalized versions, mark the number issued, sync links.
  const older = await collection.find({ orgId: doc.orgId, seriesKey: doc.seriesKey, _id: { $ne: doc._id }, status: { $in: [...ACTIVE_FINAL_STATES] } }).toArray();
  for (const o of older) {
    const r = await collection.updateOne({ _id: o._id, status: { $in: [...ACTIVE_FINAL_STATES] } }, { $set: { status: "SUPERSEDED", supersededAt: now, supersededByDocumentId: doc._id, updatedAt: now } });
    if (r.modifiedCount) {
      await recordEvidence({ orgId, documentId: o._id, nodeType: "DOCUMENT_SUPERSEDED", actorEmail: email, actorType: "system", data: { supersededByDocumentId: String(doc._id), supersededByVersion: doc.documentVersion }, previousState: o.status, newState: "SUPERSEDED" });
      await revokeAllDeliveries({ orgId, documentId: o._id, actorEmail: email, reason: "superseded" }).catch(() => {});
      const linked = await collection.findOne({ _id: doc._id });
      await linkEvidenceGraph({ orgId, doc: linked, actorEmail: email, previousDocumentId: o._id }).catch(() => {});
    }
  }
  await supersedeInFlight({ orgId, seriesKey: doc.seriesKey, exceptId: doc._id, byId: doc._id, byVersion: doc.documentVersion, actorEmail: email });
  await setNumberStatus({ orgId, documentId: doc._id, status: "ISSUED", reason: null, actorEmail: email }).catch(() => {});
  if (doc.sourceRecordType === "INVOICE" && doc.documentType === "invoice") {
    const { invoices } = await getOrgCollections();
    await invoices.updateOne({ _id: doc.sourceRecordId, orgId: doc.orgId }, { $set: { officialDocumentNumber: doc.documentNumber, officialDocumentId: doc._id } }).catch(() => {});
  }
  if (updated.businessEventId) await syncBusinessEventStatus({ orgId, eventId: String(updated.businessEventId), membership: { role: "owner" }, actorEmail: email }).catch(() => {});
  await notifyUser({ orgId, targetEmail: doc.createdByEmail, type: "document_finalized", title: `${doc.documentNumber} v${doc.documentVersion} finalized`, body: "The document is finalized, encrypted and stored. You can now share it securely.", doc: updated, dedupeKey: `${orgId}:document_finalized:${doc._id}` }).catch(() => {});
  await recordMetric({ orgId, metric: "finalize_ms", value: Date.now() - t0, dimensions: { type: doc.documentType } });
  return { document: serializeDocument(updated, { detail: true }), retention: lock };
}

// ---------------------------------------------------------------------
// Void / cancel
// ---------------------------------------------------------------------
export async function voidDocument({ orgId, documentId, reason, membership, email }) {
  const loaded = await loadDoc({ orgId, documentId, membership, email });
  if (loaded.error) return loaded;
  const { doc, def, collection } = loaded;
  if (!def.canApprove(membership)) return err("You don't have permission to void this type of document.", 403);
  const why = typeof reason === "string" ? reason.trim() : "";
  if (why.length < 3 || why.length > 500) return err("A reason of 3-500 characters is required to void a document.");
  const now = new Date().toISOString();
  const updated = await collection.findOneAndUpdate({ _id: doc._id, orgId: doc.orgId, status: { $in: TRANSITIONS.void.from } }, { $set: { status: "VOID", voidedAt: now, voidReason: why, voidedByEmail: email, updatedAt: now } }, { returnDocument: "after" });
  if (!updated) return err(`This document is ${doc.status} and cannot be voided.`, 409);
  await recordEvidence({ orgId, documentId: doc._id, nodeType: "DOCUMENT_VOIDED", actorEmail: email, actorType: "human", membership, gate: def.finance ? "canManageFinance" : "canManageOrg", data: { reason: why }, previousState: doc.status, newState: "VOID" });
  await setNumberStatus({ orgId, documentId: doc._id, status: "VOIDED", reason: why, actorEmail: email }).catch(() => {});
  await revokeAllDeliveries({ orgId, documentId: doc._id, actorEmail: email, reason: "voided" }).catch(() => {});
  return { document: serializeDocument(updated) };
}

export async function cancelDocument({ orgId, documentId, reason, membership, email }) {
  const loaded = await loadDoc({ orgId, documentId, membership, email });
  if (loaded.error) return loaded;
  const { doc, def, collection } = loaded;
  if (!def.canGenerate(membership)) return err("You don't have permission to cancel this document.", 403);
  const why = typeof reason === "string" ? reason.trim().slice(0, 500) : "";
  const now = new Date().toISOString();
  const updated = await collection.findOneAndUpdate({ _id: doc._id, orgId: doc.orgId, status: { $in: TRANSITIONS.cancel.from } }, { $set: { status: "CANCELLED", cancelledAt: now, cancelReason: why || null, updatedAt: now } }, { returnDocument: "after" });
  if (!updated) return err(`This document is ${doc.status} and cannot be cancelled (a finalized document must be voided instead).`, 409);
  await recordEvidence({ orgId, documentId: doc._id, nodeType: "DOCUMENT_CANCELLED", actorEmail: email, actorType: "human", membership, gate: "generate", data: { reason: why }, previousState: doc.status, newState: "CANCELLED" });
  await setNumberStatus({ orgId, documentId: doc._id, status: "CANCELLED", reason: why || "Cancelled before finalization", actorEmail: email }).catch(() => {});
  return { document: serializeDocument(updated) };
}

// ---------------------------------------------------------------------
// Source-driven status (PAID / CANCELLED) and expiry
// ---------------------------------------------------------------------
/** Called by the Finance invoice transition hook and by the cron sweep. */
export async function syncInvoiceDocuments({ orgId, invoiceId }) {
  const { generatedDocuments, invoices } = await getOrgCollections();
  const invoice = await invoices.findOne({ _id: toObjectId(invoiceId), orgId: toObjectId(orgId) });
  if (!invoice) return { updated: 0 };
  const target = invoice.status === "PAID" ? "PAID" : invoice.status === "CANCELLED" ? "CANCELLED" : null;
  if (!target) return { updated: 0 };
  const docs = await generatedDocuments.find({ orgId: toObjectId(orgId), documentType: "invoice", sourceRecordId: invoice._id, status: { $in: [...ACTIVE_FINAL_STATES] } }).toArray();
  let updated = 0;
  for (const d of docs) {
    const now = new Date().toISOString();
    const r = await generatedDocuments.updateOne({ _id: d._id, status: d.status }, { $set: { status: target, updatedAt: now, sourceStatus: invoice.status } });
    if (r.modifiedCount) {
      updated++;
      await recordEvidence({ orgId, documentId: d._id, nodeType: target === "PAID" ? "SOURCE_PAID" : "SOURCE_CANCELLED", actorEmail: "system:finance-sync", actorType: "system", data: { sourceStatus: invoice.status }, previousState: d.status, newState: target });
      if (target === "CANCELLED") { await revokeAllDeliveries({ orgId, documentId: d._id, actorEmail: "system:finance-sync", reason: "source cancelled" }).catch(() => {}); await setNumberStatus({ orgId, documentId: d._id, status: "VOIDED", reason: "Source invoice cancelled" }).catch(() => {}); }
    }
  }
  return { updated };
}

export async function expireStaleDocuments({ orgId } = {}) {
  const { generatedDocuments } = await getOrgCollections();
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const scope = orgId ? { orgId: toObjectId(orgId) } : {};
  let expired = 0;
  const pending = await generatedDocuments.find({ ...scope, status: "PENDING_APPROVAL", "approval.expiresAt": { $lt: now } }).limit(500).toArray();
  for (const d of pending) {
    const r = await generatedDocuments.updateOne({ _id: d._id, status: "PENDING_APPROVAL" }, { $set: { status: "EXPIRED", updatedAt: now } });
    if (r.modifiedCount) { expired++; await recordEvidence({ orgId: d.orgId, documentId: d._id, nodeType: "APPROVAL_EXPIRED", actorEmail: "system:cron", actorType: "system", data: { reason: "The approval request went stale." }, previousState: "PENDING_APPROVAL", newState: "EXPIRED" }); }
  }
  const quotes = await generatedDocuments.find({ ...scope, documentType: "quotation", status: { $in: [...ACTIVE_FINAL_STATES] }, "renderInput.viewBase.doc.validUntil": { $lt: today } }).limit(500).toArray();
  for (const d of quotes) {
    const r = await generatedDocuments.updateOne({ _id: d._id, status: d.status }, { $set: { status: "EXPIRED", updatedAt: now } });
    if (r.modifiedCount) { expired++; await recordEvidence({ orgId: d.orgId, documentId: d._id, nodeType: "DOCUMENT_EXPIRED", actorEmail: "system:cron", actorType: "system", data: { validUntil: d.renderInput?.viewBase?.doc?.validUntil }, previousState: d.status, newState: "EXPIRED" }); await revokeAllDeliveries({ orgId: d.orgId, documentId: d._id, actorEmail: "system:cron", reason: "expired" }).catch(() => {}); }
  }
  return { expired };
}

export { appBaseUrl, IN_FLIGHT_STATES };
