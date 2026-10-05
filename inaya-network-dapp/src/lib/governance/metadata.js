// src/lib/governance/metadata.js
//
// Content metadata framework (Competitive Expansion SOW D1, GOV-001). Typed fields (text, number, boolean, date, email, phone, controlled
// vocabulary) and the SOW's named governance fields as built-ins, plus organization-defined fields and "sets" that group fields for files
// matching a path/type/department. Values live on org_documents.metadata.
//
// PERMISSION-AWARE: reading needs VIEW on the document, writing needs EDIT (MANAGE for fields marked manager-only; owner/admin always),
// and fields marked `visibility: "managers"` are hidden from everyone who cannot manage the document. External collaborators (share links,
// file-request visitors) never receive metadata: no share/public route returns this object.
// Built-in fields that other subsystems own (legalHold, classification source/confidence) are read-only here.

import { ObjectId } from "mongodb";
import { getOrgCollections, toObjectId } from "../orgs.js";
import { canManageOrg, hasAdminRole } from "../orgGates.js";
import { requireDocumentAccess } from "../document-permissions.js";
import { logOrgActivity } from "../org-activity-log.js";
import { getOrgClassificationLevels } from "../classification.js";
import { GovError } from "./policies.js";

const fail = (status, message, extra) => { throw new GovError(status, message, extra); };
const nowIso = () => new Date().toISOString();
export const FIELD_TYPES = ["text", "number", "boolean", "date", "email", "phone", "vocabulary"];
const KEY = /^[a-z][a-z0-9_]{1,39}$/;

/** The governance fields the SOW names. `readOnly` ones are written only by the subsystem that owns them. */
export const BUILTIN_FIELDS = [
  { key: "sensitivity", label: "Sensitivity level", type: "vocabulary", options: null /* the org's classification levels */, builtin: true },
  { key: "department", label: "Department", type: "text", builtin: true },
  { key: "data_owner", label: "Data owner", type: "email", builtin: true },
  { key: "retention_class", label: "Retention class", type: "vocabulary", options: ["standard", "extended", "permanent", "short"], builtin: true },
  { key: "compliance_class", label: "Compliance class", type: "vocabulary", options: ["none", "gdpr", "hipaa", "sox", "pci", "other"], builtin: true },
  { key: "region", label: "Region / residency class", type: "vocabulary", options: ["any", "eu", "us", "uk", "apac", "me"], builtin: true },
  { key: "origin", label: "Origin / source", type: "text", builtin: true },
  { key: "legal_hold", label: "Legal hold", type: "boolean", builtin: true, readOnly: true },
  { key: "classification_source", label: "Classification source", type: "text", builtin: true, readOnly: true },
  { key: "classification_confidence", label: "Classification confidence", type: "number", builtin: true, readOnly: true },
];
const BUILTIN = Object.fromEntries(BUILTIN_FIELDS.map((f) => [f.key, f]));

let indexed = false;
async function cols() {
  const c = await getOrgCollections(); const fields = c.db.collection("metadata_fields"); const sets = c.db.collection("metadata_sets");
  if (!indexed) { await Promise.all([fields.createIndex({ orgId: 1, key: 1 }, { unique: true }), sets.createIndex({ orgId: 1, key: 1 }, { unique: true })]); indexed = true; }
  return { c, fields, sets };
}
const mustManage = (m) => { if (!hasAdminRole(m, "dataGovernanceAdmin")) fail(403, "Only an owner or admin can define metadata fields."); };

/** Pure: validate one value against a field definition. Returns the normalized value or throws GovError(400). */
export function coerceValue(def, value) {
  if (value === null || value === "") return null;
  const bad = (m) => fail(400, `${def.label || def.key}: ${m}`);
  switch (def.type) {
    case "text": { const s = String(value); if (s.length > 500) bad("is too long (500 characters at most)."); return s; }
    case "number": { const n = Number(value); if (!Number.isFinite(n)) bad("must be a number."); return n; }
    case "boolean": { if (typeof value === "boolean") return value; if (/^(true|yes)$/i.test(String(value))) return true; if (/^(false|no)$/i.test(String(value))) return false; return bad("must be true or false."); }
    case "date": { const d = new Date(value); if (isNaN(d)) bad("must be a valid date."); return d.toISOString().slice(0, 10); }
    case "email": { const s = String(value).trim().toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) || s.length > 200) bad("must be an email address."); return s; }
    case "phone": { const s = String(value).trim(); if (!/^\+?[0-9 ()\-.]{6,25}$/.test(s)) bad("must be a phone number."); return s; }
    case "vocabulary": { const s = String(value); if (!(def.options || []).includes(s)) bad(`must be one of: ${(def.options || []).join(", ")}.`); return s; }
    default: return bad("has an unknown type.");
  }
}

export async function listFields({ orgId, membership, includeArchived = false }) {
  const { fields } = await cols(); const levels = [...(await getOrgClassificationLevels(orgId))].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)).map((l) => l.key);
  const custom = await fields.find({ orgId: toObjectId(orgId), ...(includeArchived ? {} : { archived: { $ne: true } }) }).sort({ key: 1 }).toArray();
  const all = [...BUILTIN_FIELDS.map((f) => (f.key === "sensitivity" ? { ...f, options: levels } : f)), ...custom.map((f) => ({ key: f.key, label: f.label, type: f.type, options: f.options || null, required: !!f.required, visibility: f.visibility, editableBy: f.editableBy, archived: !!f.archived, builtin: false }))];
  return all.filter((f) => hasAdminRole(membership, "dataGovernanceAdmin") || f.visibility !== "managers");
}
export async function defineField({ orgId, actorEmail, membership, key, label, type, options = null, required = false, visibility = "members", editableBy = "edit" }) {
  mustManage(membership); const { fields } = await cols();
  if (!KEY.test(String(key))) fail(400, "key must start with a letter and use lowercase letters, digits and _ (2 to 40 characters).");
  if (BUILTIN[key]) fail(409, "That name is used by a built-in field.");
  if (!FIELD_TYPES.includes(type)) fail(400, `type must be one of ${FIELD_TYPES.join(", ")}.`);
  if (type === "vocabulary") { const o = Array.isArray(options) ? options.map((x) => String(x).trim()).filter(Boolean) : []; if (o.length < 1 || o.length > 100) fail(400, "A vocabulary field needs 1 to 100 options."); options = [...new Set(o)]; } else options = null;
  if (!["members", "managers"].includes(visibility) || !["edit", "manage"].includes(editableBy)) fail(400, "visibility or editableBy is not valid.");
  try { await fields.insertOne({ _id: new ObjectId(), orgId: toObjectId(orgId), key, label: String(label || key).slice(0, 80), type, options, required: !!required, visibility, editableBy, createdBy: actorEmail, createdAt: nowIso() }); }
  catch (e) { if (e?.code === 11000) fail(409, "A field with that key already exists."); throw e; }
  await logOrgActivity({ orgId, recordType: "METADATA_FIELD", recordId: new ObjectId(), actorEmail, action: "FIELD_DEFINED", previousState: null, newState: null, metadata: { key, type } }).catch(() => {});
  return { key };
}
/** Fields are archived, never deleted, so existing values keep their meaning. */
export async function archiveField({ orgId, actorEmail, membership, key }) {
  mustManage(membership); const { fields } = await cols();
  const r = await fields.updateOne({ orgId: toObjectId(orgId), key, archived: { $ne: true } }, { $set: { archived: true, archivedAt: nowIso() } }); if (!r.matchedCount) fail(404, "No such field.");
  await logOrgActivity({ orgId, recordType: "METADATA_FIELD", recordId: new ObjectId(), actorEmail, action: "FIELD_ARCHIVED", previousState: null, newState: null, metadata: { key } }).catch(() => {}); return { ok: true };
}

export async function defineSet({ orgId, actorEmail, membership, key, name, fieldKeys, appliesTo = {} }) {
  mustManage(membership); const { sets } = await cols(); const known = new Set((await listFields({ orgId, membership })).map((f) => f.key));
  if (!KEY.test(String(key))) fail(400, "key must start with a letter and use lowercase letters, digits and _."); if (!Array.isArray(fieldKeys) || !fieldKeys.length || fieldKeys.some((k) => !known.has(k))) fail(400, "fieldKeys must list existing fields.");
  const doc = { orgId: toObjectId(orgId), key, name: String(name || key).slice(0, 80), fieldKeys, appliesTo: { pathPrefix: appliesTo.pathPrefix || null, extensions: (appliesTo.extensions || []).map((e) => String(e).toLowerCase()), departmentIds: (appliesTo.departmentIds || []).map(String) }, updatedBy: actorEmail, updatedAt: nowIso() };
  await sets.updateOne({ orgId: doc.orgId, key }, { $set: doc, $setOnInsert: { createdAt: nowIso() } }, { upsert: true }); return { key };
}
export async function listSets({ orgId }) { const { sets } = await cols(); return (await sets.find({ orgId: toObjectId(orgId) }).sort({ key: 1 }).toArray()).map((s) => ({ key: s.key, name: s.name, fieldKeys: s.fieldKeys, appliesTo: s.appliesTo })); }
const ext = (n) => (String(n).includes(".") ? String(n).split(".").pop().toLowerCase() : "");
export function setApplies(set, doc) {
  const a = set.appliesTo || {};
  if (a.pathPrefix && !String(doc.filename ?? "").startsWith(a.pathPrefix)) return false; if (a.extensions?.length && !a.extensions.includes(ext(doc.filename))) return false;
  if (a.departmentIds?.length && !a.departmentIds.includes(String(doc.departmentId ?? ""))) return false; return true;
}

/** Visible metadata for one document, filtered to the fields the caller may see, plus the sets that apply. */
export async function getDocumentMetadata({ orgId, documentId, membership, email }) {
  const access = await requireDocumentAccess({ orgId, documentId, membership, email, minLevel: "VIEW" }); if (access.error) fail(access.status, access.error);
  const defs = await listFields({ orgId, membership: { ...membership, role: "owner" } }); const doc = access.doc; const canManage = hasAdminRole(membership, "dataGovernanceAdmin") || access.accessLevel === "MANAGE";
  const visible = defs.filter((d) => canManage || d.visibility !== "managers"); const values = {}; for (const d of visible) if (doc.metadata?.[d.key] !== undefined) values[d.key] = doc.metadata[d.key];
  const synthetic = { legal_hold: !!doc.legalHold, classification_source: doc.classificationSource || null, classification_confidence: doc.classificationConfidence ?? null, sensitivity: doc.classification || null };
  for (const [k, v] of Object.entries(synthetic)) if (v !== null && visible.some((d) => d.key === k)) values[k] = v;
  const sets = (await listSets({ orgId })).filter((s) => setApplies(s, doc));
  return { fields: visible, values, sets, canEdit: ["EDIT", "MANAGE"].includes(access.accessLevel) || hasAdminRole(membership, "dataGovernanceAdmin"), canManage };
}

export async function setDocumentMetadata({ orgId, documentId, membership, email, values, strict = false }) {
  const access = await requireDocumentAccess({ orgId, documentId, membership, email, minLevel: "EDIT" }); if (access.error) fail(access.status, access.error);
  const { c } = await cols(); const defs = Object.fromEntries((await listFields({ orgId, membership: { ...membership, role: "owner" } })).map((d) => [d.key, d]));
  const canManage = hasAdminRole(membership, "dataGovernanceAdmin") || access.accessLevel === "MANAGE"; const set = {}; const unset = {}; const changed = [];
  for (const [k, raw] of Object.entries(values || {})) {
    const def = defs[k]; if (!def) fail(400, `Unknown field "${k}".`);
    if (def.readOnly) fail(403, `${def.label} is managed by the system and cannot be edited here.`);
    if (def.visibility === "managers" && !canManage) fail(403, `You cannot edit ${def.label}.`);
    if (def.editableBy === "manage" && !canManage) fail(403, `Only someone with Manage access can change ${def.label}.`);
    if (k === "sensitivity") fail(400, "Use the classification controls to change sensitivity (a reason is required).");
    const v = coerceValue(def, raw); if (v === null) { unset[`metadata.${k}`] = ""; } else set[`metadata.${k}`] = v; changed.push(k);
  }
  if (strict) for (const d of Object.values(defs)) if (d.required && !d.readOnly) { const final = set[`metadata.${d.key}`] ?? (unset[`metadata.${d.key}`] !== undefined ? undefined : access.doc.metadata?.[d.key]); if (final === undefined || final === null) fail(400, `${d.label} is required.`); }
  if (!changed.length) return { ok: true, changed: [] };
  await c.orgDocuments.updateOne({ _id: access.doc._id, orgId: access.doc.orgId }, { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) });
  await logOrgActivity({ orgId, recordType: "DOCUMENT", recordId: access.doc._id, actorEmail: email, action: "METADATA_CHANGED", previousState: null, newState: null, metadata: { fields: changed } }).catch(() => {});
  return { ok: true, changed };
}
