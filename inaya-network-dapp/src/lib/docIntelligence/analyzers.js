// src/lib/docIntelligence/analyzers.js
//
// RDS/SageMaker/Document Intelligence Gap Expansion SOW, Workstream C, §"analyzer registry with versioning".
// An analyzer is Inaya's unit of document understanding: EXTRACT (structured fields), CLASSIFY (a label from a
// fixed set), or GENERATE (a summary/derived text). Built-in prebuilt analyzers (Invoice/PO/Receipt/Contract,
// per the SOW's §"prebuilt analyzers") are synthesized in code -- never stored, never editable, always ACTIVE --
// so they can't drift or be deleted by mistake. Org-defined custom analyzers go through the full DRAFT ->
// TESTING -> READY -> ACTIVE -> DISABLED -> ARCHIVED lifecycle the SOW requires (§2's status taxonomy, §27's
// mandatory status labels): only ACTIVE/READY analyzers may run against real, unlabeled documents; DRAFT/TESTING
// analyzers can only be run in test mode (§ evaluation workflow), and every result they produce is marked
// testMode so it never looks like a production classification.

import { toObjectId } from "../orgs.js";
import { getDocIntelligenceCollections, ensureDocIntelligenceIndexes } from "./db.js";
import { fail, nowIso, ANALYZER_STATUSES, ANALYZER_TRANSITIONS, EXTRACTION_METHODS, FIELD_TYPES } from "./common.js";
import { audit, event } from "./record.js";

// ---------------------------------------------------------------------------------------------------------- built-ins
// Field extraction schemas mirror bookkeeper/extract.js's FIELD_NAMES exactly for "invoice"/"receipt" (same
// document family, same fields) -- this is intentionally the SAME vocabulary, not a competing one, since a
// Document Intelligence result for an invoice should describe the same fields the bookkeeper already knows.
const INVOICE_FIELDS = [
  { name: "vendor", type: "string", required: false }, { name: "customer", type: "string", required: false },
  { name: "invoiceNumber", type: "string", required: true }, { name: "invoiceDate", type: "date", required: true },
  { name: "dueDate", type: "date", required: false }, { name: "currency", type: "currency", required: true },
  { name: "subtotal", type: "number", required: false }, { name: "tax", type: "number", required: false },
  { name: "discount", type: "number", required: false }, { name: "total", type: "number", required: true },
  { name: "purchaseOrderNumber", type: "string", required: false }, { name: "paymentReference", type: "string", required: false },
];
const PO_FIELDS = [
  { name: "poNumber", type: "string", required: true }, { name: "vendor", type: "string", required: true },
  { name: "orderDate", type: "date", required: false }, { name: "deliveryDate", type: "date", required: false },
  { name: "currency", type: "currency", required: false }, { name: "total", type: "number", required: false },
];
const RECEIPT_FIELDS = [
  { name: "merchant", type: "string", required: true }, { name: "transactionDate", type: "date", required: true },
  { name: "currency", type: "currency", required: false }, { name: "total", type: "number", required: true },
  { name: "paymentMethod", type: "string", required: false },
];
const CONTRACT_FIELDS = [
  { name: "parties", type: "string", required: true }, { name: "effectiveDate", type: "date", required: false },
  { name: "expiryDate", type: "date", required: false }, { name: "governingLaw", type: "string", required: false },
  { name: "contractValue", type: "number", required: false }, { name: "currency", type: "currency", required: false },
];

export const BUILTIN_ANALYZERS = [
  { analyzerKey: "prebuilt-invoice", name: "Invoice", description: "Structured fields from a supplier or customer invoice.", method: "EXTRACT", fieldSchema: INVOICE_FIELDS, builtin: true },
  { analyzerKey: "prebuilt-purchase-order", name: "Purchase Order", description: "Structured fields from a purchase order.", method: "EXTRACT", fieldSchema: PO_FIELDS, builtin: true },
  { analyzerKey: "prebuilt-receipt", name: "Receipt", description: "Structured fields from a receipt.", method: "EXTRACT", fieldSchema: RECEIPT_FIELDS, builtin: true },
  { analyzerKey: "prebuilt-contract", name: "Contract", description: "Key terms from a contract or agreement.", method: "EXTRACT", fieldSchema: CONTRACT_FIELDS, builtin: true },
  { analyzerKey: "prebuilt-classify", name: "Document Classifier", description: "Classifies a document into a general business document type.", method: "CLASSIFY", classificationLabels: ["INVOICE", "PURCHASE_ORDER", "RECEIPT", "CONTRACT", "BANK_STATEMENT", "ID_DOCUMENT", "OTHER"], builtin: true },
  { analyzerKey: "prebuilt-summarize", name: "Document Summary", description: "A short factual summary of a document's content, for review triage -- never a substitute for reading the document.", method: "GENERATE", builtin: true },
];
const builtin = (key) => { const b = BUILTIN_ANALYZERS.find((a) => a.analyzerKey === key); if (!b) return null; return { ...b, orgId: null, version: 1, status: "ACTIVE", createdAt: null, updatedAt: null }; };

// ---------------------------------------------------------------------------------------------------------- validation
function validateFieldSchema(fieldSchema) {
  if (!Array.isArray(fieldSchema) || !fieldSchema.length) return "fieldSchema must be a non-empty array for an EXTRACT analyzer.";
  if (fieldSchema.length > 60) return "fieldSchema can have at most 60 fields.";
  for (const f of fieldSchema) {
    if (!f || typeof f.name !== "string" || !/^[a-zA-Z][a-zA-Z0-9_]{0,49}$/.test(f.name)) return `Invalid field name: ${f?.name}`;
    if (!FIELD_TYPES.includes(f.type)) return `Field "${f.name}" has an unsupported type. Use one of ${FIELD_TYPES.join(", ")}.`;
  }
  const names = fieldSchema.map((f) => f.name);
  if (new Set(names).size !== names.length) return "Field names must be unique.";
  return null;
}

export const analyzerView = (a) => ({
  analyzerId: a.orgId ? String(a._id) : a.analyzerKey, analyzerKey: a.analyzerKey, name: a.name, description: a.description || "", method: a.method,
  fieldSchema: a.fieldSchema || null, classificationLabels: a.classificationLabels || null, version: a.version, status: a.status, builtin: !!a.builtin,
  createdAt: a.createdAt, updatedAt: a.updatedAt, createdBy: a.createdBy || null,
});

/** Built-ins first (stable order), then org custom analyzers, newest first. */
export async function listAnalyzers({ orgId, status = null }) {
  const c = await getDocIntelligenceCollections();
  const q = { orgId: toObjectId(orgId) };
  if (status) q.status = status;
  const custom = await c.diAnalyzers.find(q).sort({ createdAt: -1 }).toArray();
  const builtins = status && status !== "ACTIVE" ? [] : BUILTIN_ANALYZERS.map((b) => builtin(b.analyzerKey));
  return [...builtins, ...custom].map(analyzerView);
}

/** Resolves an analyzerId (a builtin key or a custom analyzer's _id) to its current definition, or null. */
export async function getAnalyzer({ orgId, analyzerId }) {
  const b = builtin(analyzerId);
  if (b) return b;
  let oid; try { oid = toObjectId(analyzerId); } catch { return null; }
  const c = await getDocIntelligenceCollections();
  return c.diAnalyzers.findOne({ _id: oid, orgId: toObjectId(orgId) });
}

export async function createAnalyzer({ orgId, name, description = "", method, fieldSchema = null, classificationLabels = null, actorEmail }) {
  await ensureDocIntelligenceIndexes();
  const n = String(name || "").trim();
  if (!n || n.length > 120) return fail("name is required (max 120 characters).");
  if (!EXTRACTION_METHODS.includes(method)) return fail(`method must be one of ${EXTRACTION_METHODS.join(", ")}.`);
  if (method === "EXTRACT") { const e = validateFieldSchema(fieldSchema); if (e) return fail(e); }
  if (method === "CLASSIFY") { if (!Array.isArray(classificationLabels) || classificationLabels.length < 2 || classificationLabels.length > 40) return fail("classificationLabels must have between 2 and 40 labels."); }
  const c = await getDocIntelligenceCollections();
  const analyzerKey = `custom-${n.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 60)}-${Date.now().toString(36)}`;
  const now = nowIso();
  const doc = { orgId: toObjectId(orgId), analyzerKey, name: n, description: String(description).slice(0, 500), method, fieldSchema: method === "EXTRACT" ? fieldSchema : null, classificationLabels: method === "CLASSIFY" ? classificationLabels.map((l) => String(l).slice(0, 60)) : null, version: 1, status: "DRAFT", builtin: false, createdAt: now, updatedAt: now, createdBy: actorEmail };
  doc._id = (await c.diAnalyzers.insertOne(doc)).insertedId;
  await event({ orgId, type: "ANALYZER_CREATED", recordId: doc._id, actorEmail, metadata: { analyzerKey, method, name: n } });
  return { analyzer: analyzerView(doc) };
}

/** Status transitions only (per SOW's lifecycle) -- an analyzer's schema/method never changes after creation;
 *  a schema change is a NEW analyzer (a new version), so results already produced never silently reinterpret. */
export async function setAnalyzerStatus({ orgId, analyzerId, status, actorEmail }) {
  if (!ANALYZER_STATUSES.includes(status)) return fail(`status must be one of ${ANALYZER_STATUSES.join(", ")}.`);
  if (builtin(analyzerId)) return fail("Built-in analyzers cannot be modified.", 403);
  let oid; try { oid = toObjectId(analyzerId); } catch { return fail("Analyzer not found.", 404); }
  const c = await getDocIntelligenceCollections();
  const a = await c.diAnalyzers.findOne({ _id: oid, orgId: toObjectId(orgId) });
  if (!a) return fail("Analyzer not found.", 404);
  if (a.builtin) return fail("Built-in analyzers cannot be modified.", 403);
  if (!ANALYZER_TRANSITIONS[a.status].includes(status)) return fail(`Cannot move an analyzer from ${a.status} to ${status}.`, 409);
  await c.diAnalyzers.updateOne({ _id: oid }, { $set: { status, updatedAt: nowIso() } });
  await event({ orgId, type: "ANALYZER_STATUS_CHANGED", recordId: oid, actorEmail, previousState: { status: a.status }, newState: { status }, metadata: { analyzerKey: a.analyzerKey } });
  return { analyzer: analyzerView({ ...a, status }) };
}
