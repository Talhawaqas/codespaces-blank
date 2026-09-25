// src/lib/documentAutomation/jobs.js
//
// Document Automation SOW §26/§27/§34 -- background jobs. The codebase's
// established background mechanism is a CRON_SECRET-gated route on the
// Vercel cron schedule (invoices-mark-overdue, execute-approved-ai-actions,
// ...), so document jobs use exactly that rather than a new queue:
//
//   - documentJobs holds one row per recoverable failure (STORAGE /
//     EVIDENCE / RENDER), org-scoped, with attempts and nextAttemptAt.
//   - processDocumentJobs() (called by /api/cron/document-automation) claims
//     each due job atomically (PENDING -> RUNNING), so overlapping cron runs
//     can never process one twice, then calls retryDocument().
//   - retryDocument() is idempotent and RE-RENDERS FROM THE STORED
//     SNAPSHOT (never re-reading a source that may have changed), reusing
//     the document's existing number. If a stored document hash is
//     reproduced byte-for-byte that is recorded; if not, the reason is.
//   - The same sweep expires stale approvals/quotations, syncs invoice
//     PAID/CANCELLED into documents, and sends link-expiry notifications.

import { getOrgCollections, toObjectId } from "../orgs.js";
import { getDocumentType } from "./documentTypes.js";
import { runGeneration, serializeDocument, PIPELINE_STATES } from "./pipeline.js";
import { recordEvidence, linkEvidenceGraph } from "./evidence.js";
import { expireStaleDocuments, syncInvoiceDocuments } from "./lifecycle.js";
import { notifyUser } from "./notify.js";
import { recordMetric } from "./metrics.js";
import { readDocumentBytes } from "./storage.js";

const MAX_ATTEMPTS = 5;
const err = (error, status = 400, extra = {}) => ({ error, status, ...extra });

/** Rebuilds the inputs runGeneration needs from what the document itself
 *  stored -- the source is deliberately NOT re-read. */
function prepFromStored(doc) {
  return {
    adapted: {
      snapshot: doc.sourceSnapshot, view: doc.renderInput.viewBase, org: doc.renderInput.org,
      counterparty: { name: doc.counterpartyName, id: doc.counterpartyId }, sourceRecords: doc.sourceRecords, departmentId: doc.departmentId,
    },
    calc: doc.calculation, validation: doc.validation, sourceDataHash: doc.sourceDataHash, calculationHash: doc.calculationHash,
    approval: { required: !!doc.approval?.required, reason: doc.approval?.reason || null },
    settings: { defaults: { margins: doc.renderInput.margins, currency: doc.renderInput.defaultCurrency } },
  };
}

export async function retryDocument({ orgId, documentId, actorEmail, membership }) {
  const { generatedDocuments } = await getOrgCollections();
  const _id = toObjectId(documentId);
  const doc = await generatedDocuments.findOne({ _id, orgId: toObjectId(orgId), deletedAt: null });
  if (!doc) return err("Document not found.", 404);
  if (membership && !getDocumentType(doc.documentType)?.canGenerate(membership)) return err("You don't have permission to retry this document.", 403);
  if (!["GENERATION_FAILED", "STORAGE_FAILED", "EVIDENCE_PENDING", "GENERATING"].includes(doc.pipelineState)) return err(`Nothing to retry (${doc.pipelineState}).`, 409);
  if (!doc.calculation || !doc.renderInput) return err("This document has no stored inputs to retry from; generate it again.", 409);

  // Atomic retry claim so two retries can't run the same document at once.
  const claimed = await generatedDocuments.findOneAndUpdate(
    { _id, pipelineState: doc.pipelineState, retryLock: { $ne: true } },
    { $set: { retryLock: true }, $inc: { retryCount: 1 } }, { returnDocument: "after" }
  );
  if (!claimed) return err("This document is already being retried.", 409);
  await recordMetric({ orgId, metric: "retry", dimensions: { stage: doc.failureStage || "unknown" } });
  try {
    if (doc.pipelineState === "EVIDENCE_PENDING" && doc.storageReference) {
      // Storage already succeeded: only re-run the missing evidence nodes.
      const ok = await recordGenerationEvidenceForRetry({ orgId, doc: claimed, actorEmail });
      if (!ok.ok) return err(`Evidence recording failed again: ${ok.error}`, 502, { documentId: String(_id), pipelineState: "EVIDENCE_PENDING" });
      await generatedDocuments.updateOne({ _id }, { $set: { pipelineState: "COMPLETE", failureReason: null, failureStage: null } });
      const fresh = await generatedDocuments.findOne({ _id });
      return { document: fresh };
    }
    const result = await runGeneration({ doc: claimed, prep: prepFromStored(claimed), membership: membership || { role: "owner" }, email: actorEmail || claimed.createdByEmail, actorType: "system", resume: true });
    if (result.error) return result;
    const fresh = await generatedDocuments.findOne({ _id });
    if (fresh.documentHash !== claimed.documentHash) {
      await recordEvidence({ orgId, documentId: _id, nodeType: "REPRODUCTION_NOTE", actorEmail: "system", actorType: "system", data: { reproduced: false, previousHash: claimed.documentHash, newHash: fresh.documentHash, reason: "The runtime (Node/ICU/library version) differs from the original render; text formatting may differ. The new bytes are the ones stored and verified." }, logActivity: false });
    } else {
      await recordEvidence({ orgId, documentId: _id, nodeType: "REPRODUCTION_NOTE", actorEmail: "system", actorType: "system", data: { reproduced: true, documentHash: fresh.documentHash }, logActivity: false });
    }
    return { document: fresh };
  } finally {
    await generatedDocuments.updateOne({ _id }, { $unset: { retryLock: "" } }).catch(() => {});
  }
}

export async function recordGenerationEvidenceForRetry({ orgId, doc, actorEmail }) {
  const { generatedDocuments } = await getOrgCollections();
  const have = new Set((doc.evidenceNodes || []).map((n) => n.nodeType));
  const common = { orgId, documentId: doc._id, actorEmail: actorEmail || doc.createdByEmail, actorType: "system", gate: "retry", documentVersion: doc.documentVersion, documentNumber: doc.documentNumber, correlationId: doc.correlationId };
  const steps = [
    ["SOURCE_SELECTED", { sourceRecords: doc.sourceRecords, documentType: doc.documentType }, true],
    ["SOURCE_SNAPSHOT", { sourceDataHash: doc.sourceDataHash }, false],
    ["CALCULATION", { calculationHash: doc.calculationHash, currency: doc.currency, roundingMode: doc.calculation?.roundingMode || null }, false],
    ["TEMPLATE_VERSION", { templateId: doc.templateId, templateVersion: doc.templateVersion, templateHash: doc.templateHash }, false],
    ["DOCUMENT_GENERATED", { documentHash: doc.draftDocumentHash, renderer: `${doc.renderer?.name}/${doc.renderer?.version}`, pages: doc.pageCount, sizeBytes: doc.sizeBytes }, true],
    ["VALIDATION_COMPLETED", { errors: doc.validation?.errors, warnings: doc.validation?.warnings, checks: (doc.validation?.checks || []).map((c) => `${c.severity}:${c.id}`) }, true],
    ["STORAGE_COMPLETED", { documentHash: doc.draftDocumentHash, storageKey: doc.draftStorageReference?.key, sizeBytes: doc.sizeBytes }, true],
  ];
  for (const [nodeType, data, log] of steps) {
    if (have.has(nodeType)) continue;
    const r = await recordEvidence({ ...common, nodeType, data, logActivity: log });
    if (!r.ok) return r;
  }
  const fresh = await generatedDocuments.findOne({ _id: doc._id });
  const link = await linkEvidenceGraph({ orgId, doc: fresh, actorEmail: actorEmail || doc.createdByEmail });
  return link.ok ? { ok: true } : { ok: false, error: link.error };
}

/** The cron entry point. `orgId` only scopes a test run; production
 *  passes nothing and sweeps every org. */
export async function processDocumentJobs({ orgId, limit = 50 } = {}) {
  const { documentJobs, generatedDocuments } = await getOrgCollections();
  const now = new Date().toISOString();
  const filter = { status: "PENDING", nextAttemptAt: { $lte: now } };
  if (orgId) filter.orgId = toObjectId(orgId);
  const due = await documentJobs.find(filter).sort({ nextAttemptAt: 1 }).limit(limit).toArray();
  const out = { claimed: 0, succeeded: 0, failed: 0, gaveUp: 0 };
  for (const job of due) {
    const claimed = await documentJobs.findOneAndUpdate({ _id: job._id, status: "PENDING" }, { $set: { status: "RUNNING", startedAt: now }, $inc: { attempts: 1 } }, { returnDocument: "after" });
    if (!claimed) continue;
    out.claimed++;
    await recordMetric({ orgId: job.orgId, metric: "queue_latency_ms", value: Date.now() - new Date(job.nextAttemptAt).getTime(), dimensions: { kind: job.kind } });
    let result;
    try { result = await retryDocument({ orgId: job.orgId, documentId: job.documentId, actorEmail: "system:cron" }); } catch (e) { result = err(e.message, 500); }
    if (!result.error || (result.status === 409 && /Nothing to retry/.test(result.error))) {
      // (A "nothing to retry" answer means the document already recovered by another path.)
      await documentJobs.updateOne({ _id: job._id }, { $set: { status: "SUCCEEDED", finishedAt: new Date().toISOString(), lastError: null } });
      out.succeeded++;
    } else if (claimed.attempts >= MAX_ATTEMPTS) {
      await documentJobs.updateOne({ _id: job._id }, { $set: { status: "GAVE_UP", finishedAt: new Date().toISOString(), lastError: String(result.error).slice(0, 300) } });
      const doc = await generatedDocuments.findOne({ _id: job.documentId });
      if (doc) await notifyUser({ orgId: job.orgId, targetEmail: doc.createdByEmail, type: "document_failure", severity: "critical", title: `${doc.documentNumber || "Document"} could not be recovered`, body: String(result.error).slice(0, 300), doc, dedupeKey: `${job.orgId}:document_gave_up:${doc._id}` }).catch(() => {});
      out.gaveUp++;
    } else {
      const backoff = Math.min(3600, 60 * 2 ** claimed.attempts) * 1000;
      await documentJobs.updateOne({ _id: job._id }, { $set: { status: "PENDING", nextAttemptAt: new Date(Date.now() + backoff).toISOString(), lastError: String(result.error).slice(0, 300) } });
      out.failed++;
    }
  }
  return out;
}

/** Link-expiry notifications (§30), once per delivery. */
export async function notifyExpiredDeliveries({ orgId } = {}) {
  const { documentDeliveries, generatedDocuments } = await getOrgCollections();
  const now = new Date().toISOString();
  const filter = { status: "ACTIVE", expiresAt: { $lt: now }, expiryNotified: false };
  if (orgId) filter.orgId = toObjectId(orgId);
  const rows = await documentDeliveries.find(filter).limit(200).toArray();
  let n = 0;
  for (const d of rows) {
    const claimed = await documentDeliveries.findOneAndUpdate({ _id: d._id, expiryNotified: false }, { $set: { expiryNotified: true, status: "EXPIRED" } });
    if (!claimed) continue;
    n++;
    const doc = await generatedDocuments.findOne({ _id: d.documentId });
    if (doc) {
      await notifyUser({ orgId: d.orgId, targetEmail: doc.createdByEmail, type: "document_link_expired", title: `Link expired for ${doc.documentNumber}`, body: `The ${d.mode === "link" ? "secure link" : "Data Room access"}${d.recipientEmail ? ` for ${d.recipientEmail}` : ""} has expired.`, doc, dedupeKey: `${d.orgId}:document_link_expired:${d._id}` });
      await recordEvidence({ orgId: d.orgId, documentId: d.documentId, nodeType: "SECURE_LINK_EXPIRED", actorEmail: "system:cron", actorType: "system", data: { deliveryId: String(d._id), mode: d.mode }, logActivity: true });
    }
  }
  return { notified: n };
}

/** Everything the daily/hourly cron does, in one call. */
export async function runDocumentAutomationSweep({ orgId } = {}) {
  const jobs = await processDocumentJobs({ orgId });
  const expiry = await expireStaleDocuments({ orgId });
  const links = await notifyExpiredDeliveries({ orgId });
  const { invoices, generatedDocuments } = await getOrgCollections();
  // Reconcile documents whose source invoice moved to PAID/CANCELLED.
  const active = await generatedDocuments.find({ ...(orgId ? { orgId: toObjectId(orgId) } : {}), documentType: "invoice", status: { $in: ["FINALIZED", "DELIVERED", "VIEWED"] } }).project({ orgId: 1, sourceRecordId: 1 }).limit(1000).toArray();
  let synced = 0;
  for (const d of active) {
    const inv = await invoices.findOne({ _id: d.sourceRecordId, orgId: d.orgId }, { projection: { status: 1 } });
    if (inv && ["PAID", "CANCELLED"].includes(inv.status)) { const r = await syncInvoiceDocuments({ orgId: d.orgId, invoiceId: d.sourceRecordId }); synced += r.updated; }
  }
  return { jobs, expiry, links, synced, states: PIPELINE_STATES.length };
}

export { serializeDocument, readDocumentBytes };
