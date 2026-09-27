// src/lib/docIntelligence/analyze.js
//
// RDS/SageMaker/Document Intelligence Gap Expansion SOW, Workstream C. Orchestrates one analyzer run against
// one uploaded document: malware scan -> encrypted storage -> text/vision extraction -> EXTRACT/CLASSIFY/
// GENERATE per the analyzer's method -> confidence+grounding -> review-queue routing -> Evidence Graph. Same
// shape and the same reused primitives as bookkeeper/documents.js's ingestDocument(), generalized past
// invoices: storeBytes (encrypted, sharded, multi-provider), scanBuffer (malware), the AI gateway, Evidence
// Graph. Nothing here is a second storage engine, a second scanner, or a second AI gateway.

import { toObjectId } from "../orgs.js";
import { getS3ObjectBody, putS3Object } from "../s3-compat/store.js";
import { ensureOwnerS3Passphrase } from "../s3-compat/credentials.js";
import { listAvailableProviders } from "../pinningProviders/index.js";
import { scanBuffer, scanRefusal } from "../support/scanner.js";
import { getDocIntelligenceCollections, ensureDocIntelligenceIndexes } from "./db.js";
import { fail, nowIso, sha256, safeFilename, checkContent, MAX_DOC_BYTES, BAD_EXT } from "./common.js";
import { getAnalyzer, analyzerView } from "./analyzers.js";
import { textFromBuffer, detectInstructions, extractDeterministicGeneric, extractFieldsWithAi, classifyWithAi, generateWithAi, mergeFields, overallConfidence } from "./extract.js";
import { audit, event, link, notify } from "./record.js";
import { openItem } from "./review.js";

export const BUCKET = "doc-intelligence";
const REVIEW_THRESHOLD = 0.85;
const ALLOWED_IMAGE_KIND = (contentType) => ["image/jpeg", "image/png", "application/pdf"].includes(contentType);

async function storeBytes({ orgId, key, buffer, contentType, actor }) {
  await ensureOwnerS3Passphrase({ type: "org", orgId: String(orgId) });
  const configured = listAvailableProviders();
  const attempts = configured.length ? [...configured].sort((a, b) => (a === "pinata" ? -1 : b === "pinata" ? 1 : 0)) : [undefined];
  let last;
  for (const providerName of attempts) {
    try { return await putS3Object({ orgId: String(orgId), bucket: BUCKET, key, bodyBuffer: buffer, contentType, actorEmail: actor || "doc-intelligence", providerName }); }
    catch (err) { last = err; console.error(`doc-intelligence storage: provider "${providerName || "default"}" failed (${String(err.message).slice(0, 100)})`); }
  }
  throw last;
}

export const resultView = (r, { full = false } = {}) => ({
  resultId: String(r._id), analyzerId: r.analyzerId, analyzerKey: r.analyzerKey, analyzerVersion: r.analyzerVersion, method: r.method,
  filename: r.filename, contentType: r.contentType, sizeBytes: r.sizeBytes, status: r.status, testMode: !!r.testMode,
  fields: r.fields || null, classification: r.classification || null, generated: r.generated || null,
  extractionConfidence: r.extractionConfidence ?? null, extractionMethod: r.extractionMethod || null, missing: r.missing || [],
  warnings: r.warnings || [], createdAt: r.createdAt, updatedAt: r.updatedAt,
  ...(full ? { corrections: r.corrections || [] } : {}),
});

/**
 * Runs `analyzerId` against one uploaded document. `departmentId` is optional (org-manager-only visibility
 * if omitted, same convention as every other department-scoped Evidence Graph subject).
 */
export async function analyzeDocument({ orgId, departmentId = null, analyzerId, filename, contentType, buffer, actor }) {
  await ensureDocIntelligenceIndexes();
  if (!Buffer.isBuffer(buffer) || !buffer.length) return fail("The file is empty.");
  if (buffer.length > MAX_DOC_BYTES) return fail(`Files can be at most ${MAX_DOC_BYTES / 1024 / 1024} MB.`, 413);
  const name = safeFilename(filename);
  if (BAD_EXT.test(name)) return fail("This file type is not accepted.", 415);
  const bad = checkContent(contentType, buffer); if (bad) return fail(bad, 415);

  const analyzer = await getAnalyzer({ orgId, analyzerId });
  if (!analyzer) return fail("Analyzer not found.", 404);
  if (!["ACTIVE", "READY", "TESTING", "DRAFT"].includes(analyzer.status)) return fail(`Analyzer is ${analyzer.status} and cannot be run.`, 409);
  const testMode = analyzer.status !== "ACTIVE";

  const oid = toObjectId(orgId);
  const c = await getDocIntelligenceCollections();
  const fingerprint = sha256(buffer);
  const existing = await c.diResults.findOne({ orgId: oid, fingerprint, analyzerKey: analyzer.analyzerKey });
  if (existing) return { result: resultView(existing), duplicate: true };

  const scan = await scanBuffer({ filename: name, buffer, mode: "static" });
  if (scan.status !== "CLEAN") { await audit({ orgId, action: "DOC_INTELLIGENCE_DOCUMENT_REFUSED", actorEmail: actor, metadata: { filename: name, scan: scan.status } }); return fail(scanRefusal(scan), 422, { reasonCode: `SCAN_${scan.status}` }); }

  const key = `${fingerprint.slice(0, 2)}/${fingerprint}/${name}`;
  let stored;
  try { for (let attempt = 0; ; attempt++) { try { stored = await storeBytes({ orgId, key, buffer, contentType, actor }); break; } catch (err) { if (attempt >= 2) throw err; await new Promise((r) => setTimeout(r, 800 * (attempt + 1))); } } }
  catch (err) { console.error("doc-intelligence storage failed:", err.message); return fail("The document could not be stored right now. Please retry.", 502, { reasonCode: "STORAGE_FAILED" }); }

  const t = await textFromBuffer(buffer, contentType);
  const instructions = detectInstructions(t.text);
  let image = null;
  if (t.needsVision) { if (!ALLOWED_IMAGE_KIND(contentType)) return fail("This document needs vision-based reading, which requires an image or a PDF.", 422); image = { mimeType: contentType, base64: buffer.toString("base64") }; }

  let fields = null, classification = null, generated = null, extractionConfidence = null, missing = [], warnings = [], extractionMethod = t.method;
  const actorEmail = actor;

  if (analyzer.method === "EXTRACT") {
    const det = image ? {} : extractDeterministicGeneric(t.text, analyzer.fieldSchema);
    const ai = await extractFieldsWithAi({ orgId, actorEmail, text: image ? null : t.text, image, fieldSchema: analyzer.fieldSchema });
    if (!ai.ok) { warnings.push(`AI extraction unavailable (${ai.code}): ${ai.reason}`); }
    fields = mergeFields(det, ai.ok ? ai.value : null, t.text, { imageOnly: !!image });
    const oc = overallConfidence(fields, analyzer.fieldSchema);
    extractionConfidence = instructions.length ? Math.min(oc.extractionConfidence, 0.5) : oc.extractionConfidence;
    missing = oc.missing;
    extractionMethod = image ? "vision-ai" : ai.ok ? "text+ai" : "text-deterministic";
  } else if (analyzer.method === "CLASSIFY") {
    const ai = await classifyWithAi({ orgId, actorEmail, text: image ? null : t.text, image, labels: analyzer.classificationLabels });
    if (!ai.ok) return fail(`Classification is unavailable right now (${ai.reason}). Please retry.`, 503, { reasonCode: ai.code });
    classification = { label: ai.value.label, confidence: ai.value.confidence };
    extractionConfidence = instructions.length ? Math.min(ai.value.confidence, 0.5) : ai.value.confidence;
    extractionMethod = image ? "vision-ai" : "text-ai";
  } else if (analyzer.method === "GENERATE") {
    const ai = await generateWithAi({ orgId, actorEmail, text: image ? null : t.text, image });
    if (!ai.ok) return fail(`Generation is unavailable right now (${ai.reason}). Please retry.`, 503, { reasonCode: ai.code });
    generated = { text: ai.value.text }; extractionConfidence = ai.value.confidence ?? null; extractionMethod = image ? "vision-ai" : "text-ai";
  }
  if (instructions.length) warnings.push("The document contains text that tries to instruct an automated system. Flagged for human review.");

  const now = nowIso();
  const needsReview = testMode || !!instructions.length || missing.length > 0 || (extractionConfidence !== null && extractionConfidence < REVIEW_THRESHOLD) || analyzer.method === "GENERATE";
  const status = needsReview ? "NEEDS_REVIEW" : "PROCESSED";
  const doc = {
    orgId: oid, departmentId: departmentId ? toObjectId(departmentId) : null, analyzerId: analyzer.orgId ? String(analyzer._id) : analyzer.analyzerKey, analyzerKey: analyzer.analyzerKey, analyzerVersion: analyzer.version, method: analyzer.method,
    filename: name, contentType, sizeBytes: buffer.length, fingerprint, storage: { bucket: BUCKET, key, versionId: stored?.versionId || null },
    scan: { status: scan.status, engines: scan.engines, scannedAt: scan.scannedAt }, status, testMode, fields, classification, generated,
    extractionConfidence, extractionMethod, missing, warnings, corrections: [], textSnippet: (t.text || "").slice(0, 1500), createdAt: now, updatedAt: now, createdBy: actor,
  };
  try { doc._id = (await c.diResults.insertOne(doc)).insertedId; }
  catch (err) { if (err?.code === 11000) { const again = await c.diResults.findOne({ orgId: oid, fingerprint, analyzerKey: analyzer.analyzerKey }); return { result: resultView(again), duplicate: true }; } throw err; }

  await event({ orgId, type: "DOCUMENT_ANALYZED", recordId: doc._id, actorEmail: actor, metadata: { resultId: String(doc._id), analyzerKey: analyzer.analyzerKey, method: analyzer.method, extractionMethod, extractionConfidence, testMode } });
  link({ orgId, subjectId: doc._id, type: "ANALYZED_BY", targetType: "DI_ANALYZER", targetId: analyzer.orgId ? String(analyzer._id) : analyzer.analyzerKey, note: `${analyzer.name} v${analyzer.version}` });
  if (instructions.length) link({ orgId, subjectId: doc._id, type: "CHECKED_BY", targetType: "DI_VALIDATION", targetId: doc._id, note: "prompt-injection instructions detected in document text" });

  if (needsReview) {
    const why = testMode ? "This analyzer is not yet ACTIVE (test mode): every result is reviewed." : instructions.length ? "The document contains suspicious embedded instructions." : missing.length ? `Missing required fields: ${missing.join(", ")}.` : analyzer.method === "GENERATE" ? "Generated text is always reviewed before it is treated as fact." : `Confidence ${Math.round((extractionConfidence || 0) * 1000) / 10}% is below the ${REVIEW_THRESHOLD * 100}% threshold.`;
    await openItem({ orgId, departmentId, resultId: doc._id, reason: why, severity: instructions.length ? "high" : "medium" });
    await event({ orgId, type: "HUMAN_REVIEW_STARTED", recordId: doc._id, actorEmail: actor, metadata: { resultId: String(doc._id), reason: why.slice(0, 160) } });
    notify({ orgId, title: "A document needs review", body: `${name}: ${why}`, dedupeKey: `di:review:${doc._id}`, severity: instructions.length ? "warning" : "info", recordId: doc._id });
  }
  return { result: resultView(doc, { full: true }), duplicate: false };
}

export async function getResult({ orgId, resultId }) {
  let oid; try { oid = toObjectId(resultId); } catch { return null; }
  const c = await getDocIntelligenceCollections();
  return c.diResults.findOne({ _id: oid, orgId: toObjectId(orgId) });
}

export async function downloadResultDocument({ orgId, resultId }) {
  const doc = await getResult({ orgId, resultId }); if (!doc) return fail("Result not found.", 404);
  const body = await getS3ObjectBody({ orgId: String(orgId), bucket: doc.storage.bucket, key: doc.storage.key });
  return { buffer: body, filename: doc.filename, contentType: doc.contentType };
}

/** `departmentIds`: null means no filter (owner/admin, sees everything); an array restricts to a plain
 *  member's assigned departments only -- the org-manager-only (departmentId: null) results are deliberately
 *  excluded for a plain member, same rule canAccessDepartment() applies everywhere else. */
export async function listResults({ orgId, departmentIds = null, analyzerKey = null, status = null, limit = 50, skip = 0 }) {
  const c = await getDocIntelligenceCollections();
  const q = { orgId: toObjectId(orgId) };
  if (departmentIds) q.departmentId = { $in: departmentIds.map((d) => toObjectId(d)) };
  if (analyzerKey) q.analyzerKey = analyzerKey;
  if (status) q.status = status;
  const [items, total] = await Promise.all([c.diResults.find(q).sort({ createdAt: -1 }).skip(skip).limit(Math.min(limit, 200)).toArray(), c.diResults.countDocuments(q)]);
  return { results: items.map((r) => resultView(r)), total };
}
