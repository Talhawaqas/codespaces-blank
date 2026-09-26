// src/lib/bookkeeper/documents.js
//
// AI Bookkeeper SOW sections 8, 9, 10, 11, 17, 23, 39, 40: capture a financial document from ANY source (upload, email relay, WhatsApp, API)
// through ONE pipeline:
//   validate (size, type, magic bytes, filename) -> malware/safety scan -> SHA-256 fingerprint -> duplicate check -> encrypted storage
//   -> text/vision extraction with provenance -> deterministic validation -> duplicate/anomaly checks -> EXTRACTED or NEEDS_REVIEW.
// A document is never posted here: it becomes a PROPOSAL. It is never silently discarded: a failure is a visible state or an error to the sender.

import { createHash } from "node:crypto";
import { toObjectId } from "../orgs.js";
import { getS3ObjectBody, putS3Object } from "../s3-compat/store.js";
import { ensureOwnerS3Passphrase } from "../s3-compat/credentials.js";
import { listAvailableProviders } from "../pinningProviders/index.js";
import { scanBuffer, scanRefusal } from "../support/scanner.js";
import { getBookkeeperCollections, ensureBookkeeperIndexes } from "./db.js";
import { fail, nowIso, sha256, normVendor, normInvoiceNo, vendorSimilarity, cents } from "./common.js";
import { ALLOWED_TYPES, MAX_DOC_BYTES, textFromBuffer, extractDeterministic, validateExtraction, extractWithAi, mergeAi, detectInstructions } from "./extract.js";
import { getSettings } from "./settings.js";
import { audit, event, link, notify } from "./record.js";

export const BUCKET = "bookkeeper-documents";
const oidOf = (id) => { try { return toObjectId(id); } catch { return null; } };

export function safeFilename(name) {
  const base = String(name || "document").split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_").replace(/^\.+/, "").trim().slice(0, 120);
  return base || "document";
}

const MAGIC = [["application/pdf", [0x25, 0x50, 0x44, 0x46]], ["image/png", [0x89, 0x50, 0x4e, 0x47]], ["image/jpeg", [0xff, 0xd8, 0xff]]];
/** The declared type must match the bytes: a PDF must start with %PDF, an image with its signature, text must contain no NUL bytes. */
export function checkContent(contentType, buffer) {
  if (!ALLOWED_TYPES[contentType]) return "This file type is not accepted. Send a PDF, JPEG, PNG, plain text or CSV.";
  const m = MAGIC.find(([t]) => t === contentType);
  if (m) { if (!m[1].every((b, i) => buffer[i] === b)) return "The file content does not match its declared type."; }
  else if (buffer.subarray(0, 4096).includes(0)) return "The file content does not look like text.";
  return null;
}
export const BAD_EXT = /\.(exe|dll|bat|cmd|com|scr|js|jse|vbs|ps1|msi|jar|sh|app|docm|xlsm|zip|rar|7z|iso|html?|svg)$/i;

async function storeBytes({ orgId, key, buffer, contentType, actor }) {
  await ensureOwnerS3Passphrase({ type: "org", orgId: String(orgId) });
  const configured = listAvailableProviders();
  const attempts = configured.length ? [...configured].sort((a, b) => (a === "pinata" ? -1 : b === "pinata" ? 1 : 0)) : [undefined];
  let last;
  for (const providerName of attempts) {
    try { return await putS3Object({ orgId: String(orgId), bucket: BUCKET, key, bodyBuffer: buffer, contentType, actorEmail: actor || "ai-bookkeeper", providerName }); }
    catch (err) { last = err; console.error(`bookkeeper storage: provider "${providerName || "default"}" failed (${String(err.message).slice(0, 100)})`); }
  }
  throw last;
}

export const documentView = (d, { full = false } = {}) => ({
  documentId: String(d._id), sourceId: d.sourceId ? String(d.sourceId) : null, channel: d.channel, filename: d.filename, contentType: d.contentType, sizeBytes: d.sizeBytes, status: d.status,
  documentType: d.documentType, direction: d.direction || null, extractionConfidence: d.extractionConfidence ?? null, extractionMethod: d.extractionMethod || null, vendor: d.fields?.vendor?.value || null, customer: d.fields?.customer?.value || null,
  invoiceNumber: d.fields?.invoiceNumber?.value || null, invoiceDate: d.fields?.invoiceDate?.value || null, dueDate: d.fields?.dueDate?.value || null, currency: d.fields?.currency?.value || null, total: d.fields?.total?.value ?? null,
  scan: d.scan?.status || null, duplicateOf: d.duplicateOf ? String(d.duplicateOf) : null, occurrences: (d.occurrences || []).length, postedExpenseId: d.postedExpenseId ? String(d.postedExpenseId) : null, anomalies: d.anomalies || [], departmentId: String(d.departmentId), createdAt: d.createdAt, updatedAt: d.updatedAt,
  ...(full ? { fields: d.fields, lineItems: d.lineItems, checks: d.checks, warnings: d.warnings, meta: d.meta || {}, missing: d.missing || [], occurrenceLog: d.occurrences || [], vendorId: d.vendorId ? String(d.vendorId) : null, customerId: d.customerId ? String(d.customerId) : null } : {}),
});

/** Ties a vendor/customer name to an existing supplier / CRM contact. Exact normalized name = strong; close name = suggestion only. */
export async function resolveParties({ orgId, departmentId, fields }) {
  const { suppliers, crmContacts } = await getBookkeeperCollections(); const oid = toObjectId(orgId);
  const out = { vendorId: null, vendorMatch: null, customerId: null, customerMatch: null };
  if (fields.vendor?.value) {
    const list = await suppliers.find({ orgId: oid, deletedAt: null }).project({ name: 1, contactEmail: 1 }).limit(2000).toArray();
    let best = null; for (const s of list) { const sc = vendorSimilarity(s.name, fields.vendor.value); if (!best || sc > best.score) best = { s, score: sc }; }
    if (best && best.score >= 0.9) { out.vendorId = best.s._id; out.vendorMatch = { name: best.s.name, score: Math.round(best.score * 1000) / 1000 }; }
  }
  if (fields.customer?.value) {
    const list = await crmContacts.find({ orgId: oid, deletedAt: null }).project({ name: 1, company: 1, email: 1 }).limit(3000).toArray();
    let best = null; for (const c of list) { const sc = Math.max(vendorSimilarity(c.company || "", fields.customer.value), vendorSimilarity(c.name || "", fields.customer.value)); if (!best || sc > best.score) best = { c, score: sc }; }
    if (best && best.score >= 0.9) { out.customerId = best.c._id; out.customerMatch = { name: best.c.company || best.c.name, score: Math.round(best.score * 1000) / 1000 }; }
  }
  return out;
}

async function orgNamesOf(orgId) { const { db } = await getBookkeeperCollections(); const o = await db.collection("orgs").findOne({ _id: toObjectId(orgId) }, { projection: { name: 1 } }); return o?.name ? [o.name] : []; }

async function runExtraction({ orgId, actor, buffer, contentType, settings, aiEnabled }) {
  const t = await textFromBuffer(buffer, contentType);
  const orgNames = await orgNamesOf(orgId);
  let det = extractDeterministic(t.text, { orgNames }); let method = t.method; let aiNote = null; let imageOnly = false;
  const instructions = detectInstructions(t.text);
  const needAi = t.needsVision || !det.fields.total || !det.fields.currency;
  if (aiEnabled && (needAi || (validateExtraction({ ...det }).extractionConfidence < settings.thresholds.extraction))) {
    try {
      const { gatedJson } = await import("../support/ai.js");
      const image = t.needsVision && ["image/png", "image/jpeg"].includes(contentType) ? { mimeType: contentType, base64: buffer.toString("base64") } : null;
      if (t.needsVision && !image) aiNote = "Scanned PDF: no local OCR engine; a person must enter the fields.";
      else {
        const r = await extractWithAi({ orgId, actorEmail: actor, text: image ? null : t.text, image, gated: gatedJson });
        if (r.ok) { det = mergeAi(det, r.value, t.text, { imageOnly: !!image }); imageOnly = !!image; method = `${method}+ai`; }
        else aiNote = `AI extraction unavailable: ${r.reason || r.code}`;
      }
    } catch (err) { aiNote = "AI extraction unavailable."; }
  } else if (t.needsVision) aiNote = "Image/scanned document needs the AI model (not enabled).";
  const v = validateExtraction(det);
  let extractionConfidence = v.extractionConfidence;
  if (instructions.length) extractionConfidence = Math.min(extractionConfidence, 0.5);
  return { text: t.text, det, validation: v, extractionConfidence, method, aiNote, instructions, imageOnly };
}

/** Builds the identity of an invoice for cross-channel duplicate detection. */
export const identityKeyOf = (fields) => (fields.invoiceNumber?.value && fields.total?.value !== undefined ? [normVendor(fields.vendor?.value || fields.customer?.value || ""), normInvoiceNo(fields.invoiceNumber.value), cents(fields.total.value), fields.currency?.value || ""].join("|") : null);

async function reviewItem({ orgId, departmentId, type, reason, recordKind, recordId, dedupeKey, confidence = null, detail = null, severity = "medium" }) {
  const { bkReviewItems } = await getBookkeeperCollections();
  const doc = { orgId: toObjectId(orgId), departmentId: toObjectId(departmentId), type, reason: String(reason).slice(0, 300), recordKind, recordId, dedupeKey, confidence, detail, severity, status: "OPEN", createdAt: nowIso(), assignedTo: null };
  try { const r = await bkReviewItems.insertOne(doc); return { created: true, id: r.insertedId }; } catch (err) { if (err?.code === 11000) return { created: false }; throw err; }
}
export { reviewItem };

/**
 * Captures one document. Returns { document, duplicate?, error? }. Idempotent by (source, externalId) and by content fingerprint.
 * opts.aiEnabled defaults to true (the AI gateway itself refuses when unavailable or blocked).
 */
export async function ingestDocument({ orgId, source, channel = "UPLOAD", filename, contentType, buffer, externalId = null, meta = {}, actor, aiEnabled = true }) {
  await ensureBookkeeperIndexes();
  const c = await getBookkeeperCollections(); const oid = toObjectId(orgId);
  if (!Buffer.isBuffer(buffer) || !buffer.length) return fail("The file is empty.");
  if (buffer.length > MAX_DOC_BYTES) return fail(`Files can be at most ${MAX_DOC_BYTES / 1024 / 1024} MB.`, 413);
  const name = safeFilename(filename);
  if (BAD_EXT.test(name)) return fail("This file type is not accepted.", 415);
  const bad = checkContent(contentType, buffer); if (bad) return fail(bad, 415);
  if (!source || String(source.orgId) !== String(oid) || source.status !== "ACTIVE") return fail("The source is not available.", 403);
  const fingerprint = sha256(buffer);

  if (externalId) {
    const prior = await c.bkDocuments.findOne({ orgId: oid, sourceId: source._id, externalId: String(externalId) });
    if (prior) return { document: documentView(prior), duplicate: true, reason: "SAME_MESSAGE" };
  }
  const existing = await c.bkDocuments.findOne({ orgId: oid, fingerprint });
  if (existing) {
    await c.bkDocuments.updateOne({ _id: existing._id }, { $push: { occurrences: { at: nowIso(), channel, sourceId: source._id, filename: name, ...(meta.messageId ? { messageId: String(meta.messageId).slice(0, 200) } : {}) } }, $set: { updatedAt: nowIso() } });
    await event({ orgId, type: "DUPLICATE_DETECTED", recordId: existing._id, actorEmail: actor, metadata: { documentId: String(existing._id), kind: "SAME_FILE", channel } });
    return { document: documentView(existing), duplicate: true, reason: "SAME_FILE" };
  }

  const scan = await scanBuffer({ filename: name, buffer, mode: "static" });
  if (scan.status !== "CLEAN") { await audit({ orgId, action: "BOOKKEEPER_DOCUMENT_REFUSED", actorEmail: actor, metadata: { filename: name, scan: scan.status, channel } }); return fail(scanRefusal(scan), 422, { reasonCode: `SCAN_${scan.status}` }); }

  const key = `${fingerprint.slice(0, 2)}/${fingerprint}/${name}`;
  let stored;
  try {
    // storage providers occasionally fail transiently (plan limits, timeouts): retry the whole provider chain before telling the sender to retry
    for (let attempt = 0; ; attempt++) { try { stored = await storeBytes({ orgId, key, buffer, contentType, actor }); break; } catch (err) { if (attempt >= 2) throw err; await new Promise((r) => setTimeout(r, 800 * (attempt + 1))); } }
  } catch (err) { console.error("bookkeeper document storage failed:", err.message); await audit({ orgId, action: "BOOKKEEPER_INGEST_FAILED", actorEmail: actor, metadata: { channel, reason: "storage" } }); return fail("The document could not be stored right now. Please retry.", 502, { reasonCode: "STORAGE_FAILED" }); }

  const settings = await getSettings(orgId);
  const x = await runExtraction({ orgId, actor, buffer, contentType, settings, aiEnabled });
  const parties = await resolveParties({ orgId, departmentId: source.departmentId, fields: x.validation.fields });
  const fields = x.validation.fields;
  if (parties.vendorMatch && fields.vendor) { fields.vendor.confidence = Math.max(fields.vendor.confidence, parties.vendorMatch.score >= 0.99 ? 0.99 : 0.97); fields.vendor.matchedSupplier = parties.vendorMatch.name; }
  if (parties.customerMatch && fields.customer) { fields.customer.confidence = Math.max(fields.customer.confidence, parties.customerMatch.score >= 0.99 ? 0.99 : 0.97); fields.customer.matchedContact = parties.customerMatch.name; }
  // recompute after a known supplier / contact raised the party confidence
  const recheck = validateExtraction({ fields, lineItems: x.det.lineItems, documentType: x.det.documentType });
  const extractionConfidence = x.instructions.length ? Math.min(recheck.extractionConfidence, 0.5) : recheck.extractionConfidence;

  const identityKey = identityKeyOf(fields);
  const anomalies = [];
  if (x.instructions.length) anomalies.push({ code: "DOCUMENT_CONTAINS_INSTRUCTIONS", detail: "Potential anomaly detected: the document contains text that tries to instruct an automated system. Human review required." });
  let duplicateOf = null;
  if (identityKey) { const dup = await c.bkDocuments.findOne({ orgId: oid, identityKey, status: { $ne: "REJECTED" } }); if (dup) duplicateOf = dup._id; }
  if (fields.invoiceNumber?.value && fields.vendor?.value && !duplicateOf) {
    const same = await c.bkDocuments.findOne({ orgId: oid, "fields.invoiceNumber.value": fields.invoiceNumber.value, "fields.vendor.value": fields.vendor.value, status: { $ne: "REJECTED" } });
    if (same && same.fields?.total?.value !== fields.total?.value) anomalies.push({ code: "INVOICE_NUMBER_REUSED", detail: `Potential anomaly detected: invoice number ${fields.invoiceNumber.value} was already used by this vendor with a different total. Human review required.` });
  }

  const now = nowIso();
  const status = duplicateOf ? "DUPLICATE" : anomalies.length || recheck.missing.length || extractionConfidence < settings.thresholds.extraction || x.det.documentType === "UNKNOWN" ? "NEEDS_REVIEW" : "EXTRACTED";
  const doc = {
    orgId: oid, departmentId: source.departmentId, sourceId: source._id, channel, externalId: externalId ? String(externalId) : null, filename: name, contentType, sizeBytes: buffer.length, fingerprint,
    storage: { bucket: BUCKET, key, versionId: stored?.versionId || null, documentId: stored?._id ? String(stored._id) : null }, scan: { status: scan.status, engines: scan.engines, scannedAt: scan.scannedAt },
    status, documentType: x.det.documentType, direction: x.det.direction, fields: recheck.fields, lineItems: x.det.lineItems.slice(0, 200), checks: recheck.checks, missing: recheck.missing, warnings: [...(x.det.warnings || []), ...(x.aiNote ? [x.aiNote] : [])],
    extractionConfidence, extractionMethod: x.method, identityKey, duplicateOf, anomalies, vendorId: parties.vendorId, customerId: parties.customerId, textSnippet: x.text.slice(0, 1500),
    meta: { ...Object.fromEntries(Object.entries(meta || {}).slice(0, 12).map(([k, v]) => [k, String(v).slice(0, 200)])) }, occurrences: [{ at: now, channel, sourceId: source._id, filename: name }], createdAt: now, updatedAt: now, createdBy: actor,
  };
  try { doc._id = (await c.bkDocuments.insertOne(doc)).insertedId; }
  catch (err) { if (err?.code === 11000) { const again = await c.bkDocuments.findOne({ orgId: oid, fingerprint }); return { document: documentView(again), duplicate: true, reason: "SAME_FILE" }; } throw err; }

  await event({ orgId, type: "FINANCIAL_DOCUMENT_RECEIVED", recordId: doc._id, actorEmail: actor, metadata: { documentId: String(doc._id), channel, sha256: fingerprint, documentType: doc.documentType, sizeBytes: buffer.length } });
  await event({ orgId, type: doc.documentType === "RECEIPT" ? "RECEIPT_EXTRACTED" : "INVOICE_EXTRACTED", recordId: doc._id, actorEmail: actor, metadata: { documentId: String(doc._id), method: x.method, extractionConfidence, missing: recheck.missing, model: x.method.includes("ai") ? "AI gateway" : null } });
  const L = (type, targetType, targetId, note) => link({ orgId, subjectType: "BOOKKEEPING_DOCUMENT", subjectId: doc._id, type, targetType, targetId, note });
  L("SOURCED_FROM", "BK_SOURCE", source._id, `${channel}${meta.messageId ? " message" : ""}`);
  L("ANALYZED_BY", "BK_EXTRACTION", doc._id, `${x.method}, confidence ${extractionConfidence}`);
  if (recheck.checks.length) L("CHECKED_BY", "BK_VALIDATION", doc._id, recheck.checks.map((k) => `${k.check}:${k.ok}`).join(", "));
  if (parties.vendorId) L("REFERENCES", "SUPPLIER", parties.vendorId, `vendor match ${parties.vendorMatch.name}`);
  if (parties.customerId) L("REFERENCES", "CRM_CONTACT", parties.customerId, `customer match ${parties.customerMatch.name}`);

  if (duplicateOf) {
    await event({ orgId, type: "DUPLICATE_DETECTED", recordId: doc._id, actorEmail: actor, metadata: { documentId: String(doc._id), duplicateOf: String(duplicateOf), kind: "SAME_INVOICE_IDENTITY", channel } });
    await reviewItem({ orgId, departmentId: source.departmentId, type: "DUPLICATE", reason: `Invoice ${fields.invoiceNumber.value} appears to be a duplicate of an earlier document.`, recordKind: "DOCUMENT", recordId: doc._id, dedupeKey: `doc:${doc._id}:dup`, severity: "high" });
    await notify({ orgId, title: "Duplicate invoice detected", body: `Invoice ${fields.invoiceNumber.value} was already captured. It will not be posted twice.`, dedupeKey: `bk:dup:${doc._id}`, severity: "warning", recordId: doc._id });
  } else if (status === "NEEDS_REVIEW") {
    const why = anomalies[0]?.detail || (recheck.missing.length ? `Missing: ${recheck.missing.join(", ")}.` : x.det.documentType === "UNKNOWN" ? "The document type could not be identified." : `Extraction confidence ${Math.round(extractionConfidence * 1000) / 10}% is below the ${Math.round(settings.thresholds.extraction * 1000) / 10}% threshold.`);
    await reviewItem({ orgId, departmentId: source.departmentId, type: anomalies.length ? "ANOMALY" : "LOW_CONFIDENCE_EXTRACTION", reason: why, recordKind: "DOCUMENT", recordId: doc._id, dedupeKey: `doc:${doc._id}:extract`, confidence: extractionConfidence, severity: anomalies.length ? "high" : "medium" });
    await event({ orgId, type: "HUMAN_REVIEW_STARTED", recordId: doc._id, actorEmail: actor, metadata: { documentId: String(doc._id), reason: why.slice(0, 160) } });
  }
  return { document: documentView(doc, { full: true }), duplicate: false };
}

/** Re-runs extraction for a stored document (retry after an AI outage). Reads the bytes back from encrypted storage. Never creates a second record. */
export async function reprocessDocument({ orgId, documentId, actor }) {
  const id = oidOf(documentId); if (!id) return fail("Document not found.", 404);
  const c = await getBookkeeperCollections(); const doc = await c.bkDocuments.findOne({ _id: id, orgId: toObjectId(orgId) });
  if (!doc) return fail("Document not found.", 404);
  if (!["NEEDS_REVIEW", "FAILED"].includes(doc.status)) return fail("Only a document waiting for review can be re-processed.", 409);
  const obj = await getS3ObjectBody({ orgId: String(orgId), bucket: doc.storage.bucket, key: doc.storage.key, versionId: doc.storage.versionId || undefined });
  if (!obj) return fail("The stored file could not be read.", 502);
  const settings = await getSettings(orgId);
  const x = await runExtraction({ orgId, actor, buffer: obj.buffer, contentType: doc.contentType, settings, aiEnabled: true });
  const fields = { ...x.validation.fields, ...Object.fromEntries(Object.entries(doc.fields || {}).filter(([, f]) => f.source === "human")) };
  const recheck = validateExtraction({ fields, lineItems: x.det.lineItems, documentType: x.det.documentType });
  const conf = x.instructions.length ? Math.min(recheck.extractionConfidence, 0.5) : recheck.extractionConfidence;
  await c.bkDocuments.updateOne({ _id: id }, { $set: { fields, lineItems: x.det.lineItems.slice(0, 200), checks: recheck.checks, missing: recheck.missing, extractionConfidence: conf, extractionMethod: x.method, documentType: x.det.documentType, direction: x.det.direction, updatedAt: nowIso() } });
  await audit({ orgId, recordId: id, action: "BOOKKEEPER_DOCUMENT_REPROCESSED", actorEmail: actor, metadata: { documentId: String(id), extractionConfidence: conf } });
  return { document: documentView(await c.bkDocuments.findOne({ _id: id }), { full: true }) };
}

export async function getDocument({ orgId, documentId }) {
  const id = oidOf(documentId); if (!id) return null;
  const { bkDocuments } = await getBookkeeperCollections();
  return bkDocuments.findOne({ _id: id, orgId: toObjectId(orgId) });
}

export async function downloadDocument({ orgId, documentId }) {
  const d = await getDocument({ orgId, documentId }); if (!d) return null;
  const obj = await getS3ObjectBody({ orgId: String(orgId), bucket: d.storage.bucket, key: d.storage.key, versionId: d.storage.versionId || undefined });
  return obj ? { filename: d.filename, contentType: d.contentType, buffer: obj.buffer, doc: d } : null;
}

export async function listDocuments({ orgId, departmentIds = null, status = null, type = null, channel = null, limit = 50, skip = 0 }) {
  const { bkDocuments } = await getBookkeeperCollections();
  const q = { orgId: toObjectId(orgId) };
  if (departmentIds) q.departmentId = { $in: departmentIds };
  if (status) q.status = status; if (type) q.documentType = type; if (channel) q.channel = channel;
  const [rows, total] = await Promise.all([bkDocuments.find(q).sort({ createdAt: -1 }).skip(Math.max(0, skip)).limit(Math.min(200, limit)).toArray(), bkDocuments.countDocuments(q)]);
  return { total, documents: rows.map((d) => documentView(d)) };
}

void createHash;
