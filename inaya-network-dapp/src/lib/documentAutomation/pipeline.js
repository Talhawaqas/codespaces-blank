// src/lib/documentAutomation/pipeline.js
//
// Document Automation SOW §1/§7/§15/§26/§27 -- the orchestration pipeline:
//
//   Inaya data -> Template -> Calculation -> Document -> Validation ->
//   (Approval -> Finalization: lifecycle.js) -> Evidence -> Encrypted
//   storage -> (Delivery: delivery.js) -> Verification (verify.js)
//
// One code path for every document type (documentTypes.js registry); this
// file never branches on a document type name.
//
// Idempotency (§26). A request carries an effective idempotency key: the
// caller's own key if given, else a deterministic hash of what would be
// produced (series + source-data hash + calculation hash + template hash +
// locale + page). The claim row is inserted FIRST under a unique index on
// (orgId, idempotencyKey) and (orgId, seriesKey, documentVersion), so a
// double click, a refresh, a worker retry or two concurrent requests
// resolve to ONE document, ONE number and ONE evidence chain; the loser
// reads and returns the winner. A number is allocated only after the claim
// is won, and a failed claim keeps its number and is resumed by retry -- a
// retry never burns a second number.
//
// Failure honesty (§27). After the claim, every stage that can fail sets an
// explicit pipelineState (GENERATION_FAILED / STORAGE_FAILED /
// EVIDENCE_PENDING) and a queryable failureReason; the document never
// appears complete unless every stage really finished. Cron
// (jobs.js) retries the recoverable states idempotently.

import { ObjectId } from "mongodb";
import { createHash } from "node:crypto";
import { getOrgCollections, toObjectId, canAccessDepartment, canManageOrg } from "../orgs.js";
import { getAccessibleScope } from "../document-permissions.js";
import { calculateDocument } from "./calculations.js";
import { getDocumentType, canViewDocument, documentVisibilityFilter } from "./documentTypes.js";
import { getDocumentSettings, getBillingLogo, approvalRequiredFor } from "./settings.js";
import { resolveTemplate } from "./templateStore.js";
import { runValidators } from "./validators.js";
import { renderDocumentPdf, getRendererInfo } from "./renderer.js";
import { normalizeLocale } from "./i18n.js";
import { canonicalHash, hashDocumentBytes, calculationHashOf, jsonSafe } from "./manifest.js";
import { allocateDocumentNumber, setNumberStatus, attachDocumentToNumber } from "./numbering.js";
import { documentKey, storeDocumentBytes, ensureDocumentBucket } from "./storage.js";
import { recordEvidence, linkEvidenceGraph, permissionContext } from "./evidence.js";
import { recordMetric } from "./metrics.js";
import { notifyFailure, notifyUser } from "./notify.js";

export const DOCUMENT_STATES = ["DRAFT", "GENERATED", "PENDING_APPROVAL", "APPROVED", "FINALIZED", "DELIVERED", "VIEWED", "PAID", "REJECTED", "VOID", "CANCELLED", "EXPIRED", "SUPERSEDED"];
export const PIPELINE_STATES = ["GENERATING", "GENERATION_FAILED", "STORAGE_PENDING", "STORAGE_FAILED", "EVIDENCE_PENDING", "FINALIZING", "DELIVERY_PENDING", "DELIVERY_FAILED", "COMPLETE"];
export const IN_FLIGHT_STATES = ["DRAFT", "GENERATED", "PENDING_APPROVAL", "APPROVED"];
export const ACTIVE_FINAL_STATES = ["FINALIZED", "DELIVERED", "VIEWED"];
const STALE_CLAIM_MS = 3 * 60 * 1000;
const MAX_OPTIONS_BYTES = 64 * 1024;

export const appBaseUrl = () => (process.env.NEXT_PUBLIC_APP_URL || process.env.APP_BASE_URL || "https://inayanetwork.com").replace(/\/+$/, "");
const sha = (s) => createHash("sha256").update(s).digest("hex");
const err = (error, status = 400, extra = {}) => ({ error, status, ...extra });

// ---------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------
export function sanitizeOptions(def, options) {
  if (options === undefined || options === null) return { options: {} };
  if (typeof options !== "object" || Array.isArray(options)) return err("options must be an object.");
  let size = 0;
  try { size = Buffer.byteLength(JSON.stringify(options), "utf8"); } catch { return err("options are not serializable."); }
  if (size > MAX_OPTIONS_BYTES) return err("options are too large.");
  const clean = {};
  for (const key of Object.keys(options)) {
    if (!def.options.includes(key)) return err(`"${key}" is not an option for a ${def.label}.`);
    const v = options[key];
    if (key === "lineItems") {
      if (!Array.isArray(v) || v.length > 500) return err("lineItems must be a list of up to 500 lines.");
      clean.lineItems = v;
    } else if (key === "delivered") {
      if (!v || typeof v !== "object" || Array.isArray(v)) return err("delivered must be an object.");
      clean.delivered = v;
    } else if (["taxPercent", "discountPercent"].includes(key)) {
      if (typeof v !== "number") return err(`${key} must be a number.`);
      clean[key] = v;
    } else {
      if (typeof v !== "string" || v.length > 1500 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(v)) return err(`${key} must be text up to 1500 characters.`);
      clean[key] = v;
    }
  }
  return { options: clean };
}

/** Loads settings + org, runs the adapter, calculation, template
 *  resolution and validators. Pure with respect to the database (no
 *  writes), so preview, generation, approval-staleness checks and retries
 *  all share it. */
export async function prepare({ orgId, documentType, sourceId, options = {}, templateId, templateVersion, locale, pageSize, membership, email, allowDraftTemplate = false }) {
  const def = getDocumentType(documentType);
  if (!def) return err(`Unknown document type "${documentType}".`);
  const { orgs } = await getOrgCollections();
  const [settings, orgDoc] = await Promise.all([getDocumentSettings(orgId), orgs.findOne({ _id: toObjectId(orgId) })]);
  if (!orgDoc) return err("Organization not found.", 404);

  const tpl = await resolveTemplate({ orgId, documentType, templateId, version: templateVersion, settings, allowDraft: allowDraftTemplate });
  if (tpl.error) return err(tpl.error, tpl.status);
  if (locale !== undefined && locale !== null && locale !== "" && !normalizeLocale(locale)) return err("Unsupported locale.");
  const chosenLocale = normalizeLocale(locale) || tpl.template.spec.locale || settings.defaults.locale;
  const size = pageSize || tpl.template.spec.page?.size || settings.defaults.pageSize;
  if (!["A4", "LETTER"].includes(size)) return err('pageSize must be "A4" or "LETTER".');

  const effectiveSourceId = documentType === "business_report" ? (options.period || sourceId) : sourceId;
  const adaptOptions = documentType === "business_report" ? { ...options, period: effectiveSourceId } : options;
  let adapted;
  try {
    adapted = await def.adapter({ orgId, sourceId: effectiveSourceId, membership, email, settings, orgDoc, options: adaptOptions, locale: chosenLocale });
  } catch (e) {
    return err(`Cannot load the source data: ${e.message}`, 400);
  }
  if (adapted.error) return err(adapted.error, adapted.status || 400);

  let calc;
  try {
    calc = jsonSafe(adapted.calcCustom || calculateDocument(adapted.calcInput));
  } catch (e) {
    return err(`Cannot generate a document: ${e.message}`, 400);
  }
  // Hashed AND stored => normalized first (see manifest.js jsonSafe).
  adapted.snapshot = jsonSafe(adapted.snapshot);
  adapted.view = jsonSafe(adapted.view);
  adapted.org = jsonSafe(adapted.org);

  if (tpl.template.spec.currency?.allowed && !tpl.template.spec.currency.allowed.includes(calc.currency)) return err(`This template supports ${tpl.template.spec.currency.allowed.join(", ")}, not ${calc.currency}.`);
  const validation = runValidators({ documentType, adapted, calc });
  const sourceDataHash = canonicalHash(adapted.snapshot);
  const calculationHash = calculationHashOf(calc);
  const seriesKey = `${documentType}:${adapted.sourceRecordType}:${adapted.sourceRecordId ? String(adapted.sourceRecordId) : ""}:${adapted.seriesSuffix || ""}`;
  const approval = approvalRequiredFor({ settings, documentType, amount: typeof calc.grandTotal === "number" ? calc.grandTotal : null });

  return {
    def, settings, orgDoc, template: tpl.template, locale: chosenLocale, pageSize: size, adapted, calc, validation,
    sourceDataHash, calculationHash, seriesKey, approval, options,
  };
}

// ---------------------------------------------------------------------
// View model + render
// ---------------------------------------------------------------------
export function buildView({ renderInput, calc, number, version, documentId, createdAt, approval, stage, isPreview, contentFingerprint }) {
  const base = renderInput.viewBase;
  const org = renderInput.org;
  const currency = calc.currency;
  const showApprovalBlock = !!approval?.required;
  const final = stage === "final" && !isPreview;
  const lines = base.lineSource === "lines" ? (calc.lineItems || []).map((l) => ({ ...l, __currency: currency })) : [];
  const flags = {
    hasTax: (calc.totalTax || 0) > 0, hasDiscount: (calc.lineDiscountTotal || 0) + (calc.invoiceDiscount || 0) > 0,
    hasShipping: (calc.shipping || 0) > 0, hasFees: (calc.fees || 0) > 0, hasPaymentTerms: !!base.doc.paymentTerms,
    hasNotes: !!base.doc.notes, hasAmountPaid: (calc.amountPaid || 0) > 0, shippingAddressDiffers: !!base.shippingDiffers,
    approvalRequired: showApprovalBlock, currencyDiffersFromDefault: !!renderInput.defaultCurrency && renderInput.defaultCurrency !== currency,
    isPreview: !!isPreview, isFinal: final || (!showApprovalBlock && !isPreview),
    isDraft: !isPreview && showApprovalBlock && !final,
  };
  return {
    doc: { ...base.doc, number: isPreview ? "PREVIEW" : number, version, generatedAt: createdAt, generatedAtFixed: Date.parse(createdAt) || 0 },
    org: { name: org.name, legalName: org.legalName, addressLines: org.addressLines, email: org.email, phone: org.phone, taxId: org.taxId, taxLabel: org.taxLabel, website: org.website, footerNote: org.footerNote },
    party: base.party,
    calc,
    lines, deliveryLines: base.deliveryLines || [], statementRows: base.statementRows || [], kpiRows: base.kpiRows || [], bulletRows: base.bulletRows || [],
    approval: { required: showApprovalBlock, status: approval?.status === "APPROVED" && final ? "APPROVED" : showApprovalBlock ? "PENDING" : null, approvedBy: approval?.decidedByEmail || null, approvedAt: approval?.decidedAt || null, version },
    flags,
    verify: { url: isPreview ? null : `${appBaseUrl()}/verify-document?id=${documentId}`, documentId: isPreview ? null : String(documentId), hash: isPreview ? null : contentFingerprint },
  };
}

export async function renderStage({ doc, renderInput, calc, stage, approval, isPreview = false }) {
  const logo = renderInput.org.hasLogo ? await getBillingLogo(doc.orgId).catch(() => null) : null;
  const view = buildView({ renderInput, calc, number: doc.documentNumber, version: doc.documentVersion, documentId: doc._id, createdAt: doc.createdAt, approval, stage, isPreview, contentFingerprint: doc.contentFingerprint });
  const overrides = { pageSize: doc.pageSize };
  if (renderInput.org.brandColor) overrides.accentColor = renderInput.org.brandColor;
  if (renderInput.margins) overrides.margins = renderInput.margins;
  return renderDocumentPdf({ spec: doc.templateSpec, view, locale: doc.locale, assets: { logo }, overrides });
}

function searchTextOf({ number, def, counterparty, status, currency, total, issueDate }) {
  return [number, def.label, counterparty, status, currency, total !== undefined && total !== null ? String(total) : "", issueDate ? String(issueDate).slice(0, 10) : ""].filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------
// Preview (no number, no storage, no evidence)
// ---------------------------------------------------------------------
export async function previewDocument({ orgId, documentType, sourceId, options, templateId, templateVersion, locale, pageSize, membership, email }) {
  const def = getDocumentType(documentType);
  if (!def) return err(`Unknown document type "${documentType}".`);
  if (!def.canGenerate(membership)) return err("You don't have permission to generate this type of document.", 403);
  const clean = sanitizeOptions(def, options);
  if (clean.error) return clean;
  const t0 = Date.now();
  const prep = await prepare({ orgId, documentType, sourceId, options: clean.options, templateId, templateVersion, locale, pageSize, membership, email, allowDraftTemplate: canManageOrg(membership) });
  if (prep.error) return prep;
  const renderInput = { viewBase: prep.adapted.view, org: prep.adapted.org, margins: prep.settings.defaults.margins, defaultCurrency: prep.settings.defaults.currency };
  let rendered;
  try {
    rendered = await renderStage({
      doc: { orgId, documentNumber: "PREVIEW", documentVersion: 0, _id: new ObjectId(), createdAt: new Date().toISOString(), templateSpec: prep.template.spec, locale: prep.locale, pageSize: prep.pageSize, contentFingerprint: null },
      renderInput, calc: prep.calc, stage: "draft", approval: { required: prep.approval.required }, isPreview: true,
    });
  } catch (e) {
    await recordMetric({ orgId, metric: "render_failure", dimensions: { stage: "preview" } });
    return err(`The document could not be rendered: ${e.message}`, 500);
  }
  await recordMetric({ orgId, metric: "render_ms", value: Date.now() - t0, dimensions: { type: documentType, stage: "preview" } });
  return {
    preview: {
      pdfBase64: rendered.buffer.toString("base64"), pages: rendered.pages, sizeBytes: rendered.buffer.length,
      template: { templateId: prep.template.templateId, version: prep.template.version, name: prep.template.name, specHash: prep.template.specHash },
      calculation: publicCalc(prep.calc), validation: prep.validation, approval: prep.approval, sourceDataHash: prep.sourceDataHash, locale: prep.locale, pageSize: prep.pageSize,
      sourceSummary: { counterparty: prep.adapted.counterparty, records: prep.adapted.sourceRecords },
    },
  };
}

export function publicCalc(calc) {
  const { _minorUnits, ...rest } = calc;
  return rest;
}

// ---------------------------------------------------------------------
// Generate
// ---------------------------------------------------------------------
async function markFailed({ doc, stage, state, error }) {
  const { generatedDocuments } = await getOrgCollections();
  await generatedDocuments.updateOne({ _id: doc._id }, { $set: { pipelineState: state, failureStage: stage, failureReason: String(error).slice(0, 500), updatedAt: new Date().toISOString() }, $inc: { retryCount: 0 } });
  await recordMetric({ orgId: doc.orgId, metric: stage === "render" ? "render_failure" : stage === "storage" ? "storage_failure" : "evidence_failure", dimensions: { type: doc.documentType } });
  await notifyFailure({ orgId: doc.orgId, doc, stage, message: error }).catch(() => {});
}

export async function createDocument({ orgId, documentType, sourceId, options, templateId, templateVersion, locale, pageSize, membership, email, actorType = "human", idempotencyKey, forceNewVersion = false, correlationId }) {
  const t0 = Date.now();
  const def = getDocumentType(documentType);
  if (!def) return err(`Unknown document type "${documentType}".`);
  if (!def.canGenerate(membership)) return err("You don't have permission to generate this type of document.", 403);
  if (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 100)) return err("idempotencyKey must be 8-100 characters.");
  const clean = sanitizeOptions(def, options);
  if (clean.error) return clean;

  const prep = await prepare({ orgId, documentType, sourceId, options: clean.options, templateId, templateVersion, locale, pageSize, membership, email });
  if (prep.error) return prep;
  if (!prep.validation.passed) {
    return err(`This document cannot be generated: ${prep.validation.checks.filter((c) => c.severity === "error").map((c) => c.message).join(" ")}`, 422, { validation: prep.validation });
  }

  const { generatedDocuments } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const { adapted, calc, template, settings } = prep;

  const derivedKey = sha(`${orgId}|${prep.seriesKey}|${prep.sourceDataHash}|${prep.calculationHash}|${template.specHash}|${prep.locale}|${prep.pageSize}`);
  const latest = await generatedDocuments.find({ orgId: orgObjectId, seriesKey: prep.seriesKey }).sort({ documentVersion: -1 }).limit(1).next();

  // ---- idempotent replay ---------------------------------------------
  const replayFilter = idempotencyKey
    ? { orgId: orgObjectId, idempotencyKey: `c:${sha(`${orgId}|${idempotencyKey}`)}` }
    : !forceNewVersion && latest && !["SUPERSEDED", "VOID", "CANCELLED", "REJECTED", "EXPIRED"].includes(latest.status) && latest.derivedKey === derivedKey
      ? { _id: latest._id } : null;
  if (replayFilter) {
    const existing = await generatedDocuments.findOne(replayFilter);
    if (existing) return replayOrResume({ existing, membership, email });
  }

  // ---- concurrent generation guard -----------------------------------
  if (latest && latest.pipelineState === "GENERATING" && Date.now() - new Date(latest.createdAt).getTime() < STALE_CLAIM_MS) {
    return err("A version of this document is already being generated. Try again in a moment.", 409, { documentId: String(latest._id), inProgress: true });
  }

  // ---- claim ----------------------------------------------------------
  const documentId = new ObjectId();
  const now = new Date().toISOString();
  const version = (latest?.documentVersion || 0) + 1;
  const effectiveKey = idempotencyKey ? `c:${sha(`${orgId}|${idempotencyKey}`)}` : `d:${derivedKey}${forceNewVersion ? `:v${version}` : ""}`;
  const claim = {
    _id: documentId, orgId: orgObjectId, departmentId: adapted.departmentId ? toObjectId(adapted.departmentId) : null,
    documentType, documentVersion: version, seriesKey: prep.seriesKey,
    sourceRecordType: adapted.sourceRecordType, sourceRecordId: adapted.sourceRecordId || null, sourceRecords: adapted.sourceRecords,
    documentNumber: null, status: "DRAFT", pipelineState: "GENERATING", failureReason: null, failureStage: null, retryCount: 0,
    templateId: template.templateId, templateVersion: template.version, templateVersionLabel: template.versionLabel, templateHash: template.specHash, templateName: template.name, templateSpec: template.spec,
    locale: prep.locale, pageSize: prep.pageSize, options: prep.options,
    idempotencyKey: effectiveKey, derivedKey, correlationId: correlationId || documentId.toString(),
    createdByEmail: email, createdByActorType: actorType, createdAt: now, updatedAt: now, finalizedAt: null, supersededAt: null, deletedAt: null,
    evidenceNodes: [], evidenceSeq: 0, evidenceHead: null,
  };
  try {
    await generatedDocuments.insertOne(claim);
  } catch (e) {
    if (e?.code === 11000) {
      const winner = await generatedDocuments.findOne({ orgId: orgObjectId, idempotencyKey: effectiveKey });
      if (winner) return replayOrResume({ existing: winner, membership, email });
      return err("Another version of this document was created at the same time. Reload and try again.", 409);
    }
    throw e;
  }
  return runGeneration({ doc: claim, prep, membership, email, actorType, t0, latest });
}

/** Returns an existing document for an idempotent replay, resuming a
 *  recoverable failure rather than creating a duplicate. */
async function replayOrResume({ existing, membership, email }) {
  if (!canViewDocument(membership, existing, email)) return err("Document not found.", 404);
  if (["GENERATION_FAILED", "STORAGE_FAILED", "EVIDENCE_PENDING"].includes(existing.pipelineState) || (existing.pipelineState === "GENERATING" && Date.now() - new Date(existing.createdAt).getTime() >= STALE_CLAIM_MS)) {
    const { retryDocument } = await import("./jobs.js");
    const retried = await retryDocument({ orgId: existing.orgId, documentId: existing._id, actorEmail: email, membership });
    if (!retried.error) return { document: serializeDocument(retried.document), validation: retried.document.validation, idempotentReplay: true, resumed: true };
    return { ...retried, documentId: String(existing._id) };
  }
  if (existing.pipelineState === "GENERATING") return err("This document is being generated. Try again in a moment.", 409, { documentId: String(existing._id), inProgress: true });
  return { document: serializeDocument(existing), validation: existing.validation, idempotentReplay: true };
}

/** Executes the stages after a claim is won. Also used by retry (jobs.js)
 *  on a claim/failed document, reusing its number and stored inputs. */
export async function runGeneration({ doc, prep, membership, email, actorType = "human", t0 = Date.now(), latest, resume = false }) {
  const { generatedDocuments } = await getOrgCollections();
  const orgId = doc.orgId;
  const { adapted, calc, settings } = prep;
  const def = getDocumentType(doc.documentType);
  const amount = typeof calc.grandTotal === "number" ? calc.grandTotal : null;

  // -- number -----------------------------------------------------------
  let number = doc.documentNumber;
  if (!number) {
    if (latest && !["VOID", "CANCELLED"].includes(latest.status) && latest.documentNumber) number = latest.documentNumber;
    else {
      const issue = adapted.view?.doc?.issueDate || null;
      // A template may carry its own numbering configuration (prefix / fiscal-year reset).
      const tn = doc.templateSpec?.numbering || {};
      const numSettings = settings.numbering ? { ...settings, numbering: { ...settings.numbering, ...(tn.fiscalYearReset !== undefined ? { fiscalYearReset: tn.fiscalYearReset } : {}) } } : undefined;
      const alloc = await allocateDocumentNumber({ orgId, documentType: doc.documentType, issueDate: issue, allocatedBy: email, documentId: doc._id, settings: numSettings, prefixOverride: tn.prefix });
      number = alloc.number;
    }
  }
  const contentFingerprint = canonicalHash({ sourceDataHash: prep.sourceDataHash, calculationHash: prep.calculationHash, templateHash: doc.templateHash, number, version: doc.documentVersion });
  const renderInput = jsonSafe({ viewBase: adapted.view, org: adapted.org, margins: settings.defaults.margins, defaultCurrency: settings.defaults.currency });
  const approval = { required: prep.approval.required, status: null };
  const draftStage = prep.approval.required ? "draft" : "final";
  const enriched = { ...doc, documentNumber: number, contentFingerprint };

  // -- render -----------------------------------------------------------
  let rendered;
  const tRender = Date.now();
  try {
    rendered = await renderStage({ doc: enriched, renderInput, calc, stage: draftStage, approval });
  } catch (e) {
    await generatedDocuments.updateOne({ _id: doc._id }, { $set: { documentNumber: number } });
    await markFailed({ doc: { ...enriched }, stage: "render", state: "GENERATION_FAILED", error: e.message });
    if (number) await attachDocumentToNumber({ orgId, number, documentId: doc._id }).catch(() => {});
    return err(`Document generation failed while rendering: ${e.message}`, 500, { documentId: String(doc._id), pipelineState: "GENERATION_FAILED" });
  }
  await recordMetric({ orgId, metric: "render_ms", value: Date.now() - tRender, dimensions: { type: doc.documentType } });
  await recordMetric({ orgId, metric: "document_bytes", value: rendered.buffer.length, dimensions: { type: doc.documentType } });
  await recordMetric({ orgId, metric: "document_pages", value: rendered.pages, dimensions: { type: doc.documentType } });

  const documentHash = hashDocumentBytes(rendered.buffer);
  const counterparty = adapted.counterparty?.name || "";

  // -- persist everything known so far, then store ------------------------
  const base = {
    documentNumber: number, contentFingerprint, sourceSnapshot: adapted.snapshot, sourceDataHash: prep.sourceDataHash,
    calculation: calc, calculationHash: prep.calculationHash, validation: prep.validation, renderInput, renderer: rendered.renderer,
    currency: calc.currency, grandTotal: typeof calc.grandTotal === "number" ? calc.grandTotal : null, amountDue: typeof calc.amountDue === "number" ? calc.amountDue : null,
    counterpartyName: counterparty, counterpartyId: adapted.counterparty?.id || null,
    searchText: searchTextOf({ number, def, counterparty, status: "GENERATED", currency: calc.currency, total: amount, issueDate: adapted.view?.doc?.issueDate }),
    approval: { required: prep.approval.required, reason: prep.approval.reason, status: null },
    draftDocumentHash: documentHash, documentHash, sizeBytes: rendered.buffer.length, pageCount: rendered.pages,
    pipelineState: "STORAGE_PENDING", updatedAt: new Date().toISOString(),
    delivery: { state: "NONE", lastDeliveryId: null },
  };
  await generatedDocuments.updateOne({ _id: doc._id }, { $set: base });
  await attachDocumentToNumber({ orgId, number, documentId: doc._id }).catch(() => {});

  const key = documentKey({ documentType: doc.documentType, documentId: doc._id, version: doc.documentVersion, number, stage: draftStage });
  const tStore = Date.now();
  let stored;
  try {
    stored = await storeDocumentBytes({ orgId, key, bytes: rendered.buffer, actorEmail: email, tags: { documentType: doc.documentType, documentId: String(doc._id), version: String(doc.documentVersion) } });
  } catch (e) {
    await markFailed({ doc: { ...enriched, ...base }, stage: "storage", state: "STORAGE_FAILED", error: e.message });
    await setNumberStatus({ orgId, documentId: doc._id, status: "ALLOCATED", reason: "Storage failed; retry will reuse this number." }).catch(() => {});
    await enqueueRetry({ orgId, documentId: doc._id, kind: "STORAGE", reason: e.message });
    return err(`Document generation failed during storage: ${e.message}`, 502, { documentId: String(doc._id), pipelineState: "STORAGE_FAILED" });
  }
  await recordMetric({ orgId, metric: "storage_ms", value: Date.now() - tStore, dimensions: { type: doc.documentType } });
  const storageReference = { bucket: stored.bucket, key: stored.key, objectId: stored.objectId, versionId: stored.versionId, contentSha256: stored.contentSha256 };
  await generatedDocuments.updateOne({ _id: doc._id }, { $set: { status: "GENERATED", storageReference, draftStorageReference: storageReference, pipelineState: "EVIDENCE_PENDING", failureReason: null, failureStage: null, updatedAt: new Date().toISOString() } });

  // -- evidence ---------------------------------------------------------
  const evOk = await recordGenerationEvidence({ orgId, docId: doc._id, doc: { ...enriched, ...base, storageReference }, prep, membership, email, actorType, documentHash, stored, isResume: resume });
  const fresh = await generatedDocuments.findOne({ _id: doc._id });
  let state = "COMPLETE";
  if (!evOk.ok) {
    state = "EVIDENCE_PENDING";
    await generatedDocuments.updateOne({ _id: doc._id }, { $set: { failureStage: "evidence", failureReason: String(evOk.error).slice(0, 300) } });
    await recordMetric({ orgId, metric: "evidence_failure", dimensions: { type: doc.documentType } });
    await enqueueRetry({ orgId, documentId: doc._id, kind: "EVIDENCE", reason: evOk.error });
  } else {
    await generatedDocuments.updateOne({ _id: doc._id }, { $set: { pipelineState: "COMPLETE" } });
    // Any recovery job queued for an earlier failure of this document is now moot.
    const { documentJobs } = await getOrgCollections();
    await documentJobs.updateMany({ documentId: doc._id, status: { $in: ["PENDING", "RUNNING"] } }, { $set: { status: "SUCCEEDED", finishedAt: new Date().toISOString(), lastError: null } });
  }

  // -- supersede older unfinalized drafts of the same series ---------------
  await supersedeInFlight({ orgId, seriesKey: doc.seriesKey, exceptId: doc._id, byId: doc._id, byVersion: doc.documentVersion, actorEmail: email });

  await notifyUser({ orgId, targetEmail: email, type: "document_generated", title: `${number} v${doc.documentVersion} generated`, body: `${def.label} for ${counterparty || "your organization"} is ready${prep.approval.required ? " and needs approval before it can be finalized" : ""}.`, doc: fresh, dedupeKey: `${orgId}:document_generated:${doc._id}` }).catch(() => {});
  await recordMetric({ orgId, metric: "generation_ms", value: Date.now() - t0, dimensions: { type: doc.documentType } });

  const final = await generatedDocuments.findOne({ _id: doc._id });
  return { document: serializeDocument({ ...final, pipelineState: state }), validation: prep.validation, idempotentReplay: false };
}

async function recordGenerationEvidence({ orgId, docId, doc, prep, membership, email, actorType, documentHash, stored, isResume }) {
  const common = { orgId, documentId: docId, actorEmail: email, actorType, membership, gate: "generate", documentVersion: doc.documentVersion, documentNumber: doc.documentNumber, correlationId: doc.correlationId };
  const { generatedDocuments } = await getOrgCollections();
  const existing = new Set(((await generatedDocuments.findOne({ _id: docId }, { projection: { evidenceNodes: 1 } }))?.evidenceNodes || []).map((n) => n.nodeType));
  const steps = [
    ["SOURCE_SELECTED", { sourceRecords: doc.sourceRecords, documentType: doc.documentType }, true],
    ["SOURCE_SNAPSHOT", { sourceDataHash: prep.sourceDataHash }, false],
    ["CALCULATION", { calculationHash: prep.calculationHash, currency: prep.calc.currency, roundingMode: prep.calc.roundingMode || null }, false],
    ["TEMPLATE_VERSION", { templateId: doc.templateId, templateVersion: doc.templateVersion, templateHash: doc.templateHash }, false],
    ["DOCUMENT_GENERATED", { documentHash, renderer: `${doc.renderer?.name}/${doc.renderer?.version}`, pages: doc.pageCount, sizeBytes: doc.sizeBytes }, true],
    ["VALIDATION_COMPLETED", { errors: prep.validation.errors, warnings: prep.validation.warnings, checks: prep.validation.checks.map((c) => `${c.severity}:${c.id}`) }, true],
    ["STORAGE_COMPLETED", { documentHash, storageKey: stored.key, sizeBytes: stored.sizeBytes, versionId: stored.versionId }, true],
  ];
  const t0 = Date.now();
  for (const [nodeType, data, log] of steps) {
    if (existing.has(nodeType)) continue;
    const r = await recordEvidence({ ...common, nodeType, data, logActivity: log, newState: nodeType === "DOCUMENT_GENERATED" ? "GENERATED" : null });
    if (!r.ok) return r;
  }
  const fresh = await generatedDocuments.findOne({ _id: docId });
  const link = await linkEvidenceGraph({ orgId, doc: fresh, actorEmail: email, previousDocumentId: null });
  await recordMetric({ orgId, metric: "evidence_ms", value: Date.now() - t0, dimensions: { type: doc.documentType } });
  return link.ok ? { ok: true } : { ok: false, error: link.error };
}

/** Marks every not-yet-finalized version of a series SUPERSEDED when a newer
 *  version is generated (an unapproved draft is replaced, an approved
 *  finalized version stays valid until its successor is finalized). */
export async function supersedeInFlight({ orgId, seriesKey, exceptId, byId, byVersion, actorEmail }) {
  const { generatedDocuments } = await getOrgCollections();
  const older = await generatedDocuments.find({ orgId: toObjectId(orgId), seriesKey, _id: { $ne: exceptId }, status: { $in: IN_FLIGHT_STATES } }).toArray();
  const now = new Date().toISOString();
  for (const d of older) {
    const res = await generatedDocuments.updateOne({ _id: d._id, status: { $in: IN_FLIGHT_STATES } }, { $set: { status: "SUPERSEDED", supersededAt: now, supersededByDocumentId: byId, updatedAt: now } });
    if (res.modifiedCount) await recordEvidence({ orgId, documentId: d._id, nodeType: "DOCUMENT_SUPERSEDED", actorEmail, actorType: "system", data: { supersededByDocumentId: String(byId), supersededByVersion: byVersion, reason: "A newer version was generated before this one was finalized." }, previousState: d.status, newState: "SUPERSEDED" });
  }
}

export async function enqueueRetry({ orgId, documentId, kind, reason }) {
  try {
    const { documentJobs } = await getOrgCollections();
    const now = new Date().toISOString();
    await documentJobs.updateOne(
      { orgId: toObjectId(orgId), documentId: toObjectId(documentId), kind, status: { $in: ["PENDING", "RUNNING"] } },
      { $setOnInsert: { orgId: toObjectId(orgId), documentId: toObjectId(documentId), kind, status: "PENDING", attempts: 0, createdAt: now, nextAttemptAt: new Date(Date.now() + 60_000).toISOString() }, $set: { lastError: String(reason).slice(0, 300), updatedAt: now } },
      { upsert: true }
    );
  } catch (e) {
    console.error("enqueueRetry failed (non-fatal):", e.message);
  }
}

// ---------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------
/** Public shape: never includes the template spec, snapshot or render input. */
export function serializeDocument(doc, { detail = false } = {}) {
  if (!doc) return null;
  const a = doc.approval || {};
  const out = {
    id: String(doc._id), orgId: String(doc.orgId), departmentId: doc.departmentId ? String(doc.departmentId) : null,
    documentType: doc.documentType, documentNumber: doc.documentNumber, documentVersion: doc.documentVersion, status: doc.status, pipelineState: doc.pipelineState || null,
    failureStage: doc.failureStage || null, failureReason: doc.failureReason || null, retryCount: doc.retryCount || 0,
    sourceRecordType: doc.sourceRecordType, sourceRecordId: doc.sourceRecordId ? String(doc.sourceRecordId) : null,
    templateId: doc.templateId, templateVersion: doc.templateVersion, templateName: doc.templateName || null, locale: doc.locale, pageSize: doc.pageSize,
    currency: doc.currency || null, grandTotal: doc.grandTotal ?? null, amountDue: doc.amountDue ?? null, counterpartyName: doc.counterpartyName || null,
    documentHash: doc.documentHash || null, draftDocumentHash: doc.draftDocumentHash || null, sizeBytes: doc.sizeBytes || null, pageCount: doc.pageCount || null,
    storageReference: doc.storageReference ? { bucket: doc.storageReference.bucket, key: doc.storageReference.key, versionId: doc.storageReference.versionId } : null,
    approval: { required: !!a.required, reason: a.reason || null, status: a.status || null, requestedByEmail: a.requestedByEmail || null, requestedAt: a.requestedAt || null, decidedByEmail: a.decidedByEmail || null, decidedAt: a.decidedAt || null, decisionNote: a.decisionNote || null, expiresAt: a.expiresAt || null, boundVersion: a.boundVersion ?? null },
    validation: doc.validation ? { errors: doc.validation.errors, warnings: doc.validation.warnings, passed: doc.validation.passed } : null,
    evidence: { nodes: (doc.evidenceNodes || []).length, root: doc.evidenceHead || null, businessEventId: doc.businessEventId ? String(doc.businessEventId) : null },
    delivery: doc.delivery || { state: "NONE" },
    createdByEmail: doc.createdByEmail, createdByActorType: doc.createdByActorType || "human", createdAt: doc.createdAt, updatedAt: doc.updatedAt, finalizedAt: doc.finalizedAt || null,
    supersededAt: doc.supersededAt || null, supersededByDocumentId: doc.supersededByDocumentId ? String(doc.supersededByDocumentId) : null, voidedAt: doc.voidedAt || null, voidReason: doc.voidReason || null,
    sourceDataHash: doc.sourceDataHash || null, calculationHash: doc.calculationHash || null, templateHash: doc.templateHash || null,
  };
  if (detail) {
    out.manifest = doc.manifest || null;
    out.validationChecks = doc.validation?.checks || [];
    out.calculation = doc.calculation ? publicCalc(doc.calculation) : null;
    out.renderer = doc.renderer || null;
  }
  return out;
}

export async function getDocument({ orgId, documentId, membership, email, detail = true }) {
  let _id;
  try { _id = toObjectId(documentId); } catch { return err("Document not found.", 404); }
  const { generatedDocuments } = await getOrgCollections();
  const doc = await generatedDocuments.findOne({ _id, orgId: toObjectId(orgId), deletedAt: null });
  if (!doc || !canViewDocument(membership, doc, email)) return err("Document not found.", 404);
  return { document: serializeDocument(doc, { detail }), raw: doc };
}

export async function listDocuments({ orgId, membership, email, documentType, status, sourceRecordType, sourceRecordId, seriesKey, q, limit = 50, skip = 0 }) {
  const scope = await getAccessibleScope({ orgId, membership, email });
  const visibleDepartmentIds = scope.visibleDepartments.map((d) => d._id);
  const { generatedDocuments } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId), deletedAt: null, ...documentVisibilityFilter({ membership, email, visibleDepartmentIds }) };
  const and = [];
  if (documentType) and.push({ documentType });
  if (status) and.push({ status });
  if (sourceRecordType) and.push({ sourceRecordType });
  if (sourceRecordId) { try { and.push({ sourceRecordId: toObjectId(sourceRecordId) }); } catch { return { documents: [], total: 0 }; } }
  if (seriesKey) and.push({ seriesKey });
  if (q && q.trim()) and.push({ searchText: { $regex: q.trim().slice(0, 60).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } });
  const finalQuery = and.length ? { $and: [query, ...and] } : query;
  const rows = await generatedDocuments.find(finalQuery).sort({ createdAt: -1 }).skip(Math.max(0, skip)).limit(Math.min(Math.max(1, limit), 200)).toArray();
  return { documents: rows.map((d) => serializeDocument(d)) };
}

export { permissionContext };
