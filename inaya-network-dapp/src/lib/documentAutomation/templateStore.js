// src/lib/documentAutomation/templateStore.js
//
// Document Automation SOW §5/§23/§26/§29/§33 -- versioned template CRUD.
//
//   - System templates (systemTemplates.js) are code-defined and immutable.
//   - An organization customizes by creating its own template (optionally
//     cloned from a system one). Each template has a stable templateKey and
//     integer versions. A version is DRAFT (editable), PUBLISHED
//     (immutable -- the spec can never change again) or ARCHIVED (kept;
//     documents generated from it remain traceable and reproducible).
//   - Version numbers come from an atomic counter, and DRAFT->PUBLISHED is
//     an atomic status-guarded update, so concurrent creates/publishes can
//     neither duplicate a version nor publish twice.
//   - Every write is validated by validateTemplateSpec (safe language, size
//     limits) and audited on the org's chain (§29).
//   - Managing templates is an owner/admin capability; org isolation is
//     structural (every query carries orgId; "org:<key>" ids never resolve
//     another org's template).

import { randomBytes } from "node:crypto";
import { getOrgCollections, toObjectId, canManageOrg } from "../orgs.js";
import { logOrgActivity } from "../org-activity-log.js";
import { validateTemplateSpec } from "./templateSchema.js";
import { SYSTEM_TEMPLATES, DEFAULT_TEMPLATE_BY_TYPE, listSystemTemplates, getSystemTemplate } from "./systemTemplates.js";

const MAX_TEMPLATES_PER_ORG = 200;
const MAX_VERSIONS_PER_TEMPLATE = 200;

function publicShape(t) {
  return {
    templateId: t.isSystem ? t.templateId : `org:${t.templateKey}`, templateKey: t.templateKey || t.key, version: t.version,
    versionLabel: t.versionLabel || `${t.version}.0.0`, documentType: t.documentType, name: t.name, description: t.spec?.description || null,
    status: t.status, isSystem: !!t.isSystem, specHash: t.specHash, spec: t.spec, ownerEmail: t.ownerEmail || null,
    changeNote: t.changeNote || null, createdAt: t.createdAt || null, updatedAt: t.updatedAt || null, publishedAt: t.publishedAt || null, archivedAt: t.archivedAt || null,
    id: t._id ? String(t._id) : null,
  };
}

function gate(membership) {
  if (!canManageOrg(membership)) return { error: "Only an owner or admin can manage document templates.", status: 403 };
  return null;
}

async function nextVersion(orgId, templateKey) {
  const { documentTemplateCounters } = await getOrgCollections();
  const r = await documentTemplateCounters.findOneAndUpdate(
    { _id: `${orgId}:${templateKey}` }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: "after" }
  );
  return r.seq;
}

export async function listTemplates({ orgId, documentType, includeArchived = false }) {
  const { documentTemplates } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId) };
  if (documentType) query.documentType = documentType;
  if (!includeArchived) query.status = { $ne: "ARCHIVED" };
  const own = await documentTemplates.find(query).sort({ templateKey: 1, version: -1 }).limit(1000).toArray();
  const system = listSystemTemplates().filter((t) => !documentType || t.documentType === documentType);
  return [...system.map(publicShape), ...own.map(publicShape)];
}

export async function getTemplate({ orgId, templateId, version, allowDraft = false }) {
  if (!templateId || typeof templateId !== "string") return { error: "templateId is required.", status: 400 };
  if (templateId.startsWith("system:")) {
    const t = getSystemTemplate(templateId);
    return t ? { template: publicShape(t) } : { error: "Template not found.", status: 404 };
  }
  if (!templateId.startsWith("org:")) return { error: "Template not found.", status: 404 };
  const templateKey = templateId.slice(4);
  if (!/^[a-z0-9-]{3,60}$/.test(templateKey)) return { error: "Template not found.", status: 404 };
  const { documentTemplates } = await getOrgCollections();
  const base = { orgId: toObjectId(orgId), templateKey };
  let doc;
  if (version !== undefined && version !== null) {
    doc = await documentTemplates.findOne({ ...base, version: Number(version) });
    if (doc && doc.status === "DRAFT" && !allowDraft) return { error: "That template version is a draft and has not been published.", status: 409 };
  } else {
    doc = await documentTemplates.find({ ...base, status: "PUBLISHED" }).sort({ version: -1 }).limit(1).next();
    if (!doc && allowDraft) doc = await documentTemplates.find(base).sort({ version: -1 }).limit(1).next();
  }
  if (!doc) return { error: "Template not found.", status: 404 };
  return { template: publicShape(doc) };
}

export async function listTemplateVersions({ orgId, templateId }) {
  if (templateId.startsWith("system:")) {
    const t = getSystemTemplate(templateId);
    return t ? { versions: [publicShape(t)] } : { error: "Template not found.", status: 404 };
  }
  const templateKey = templateId.replace(/^org:/, "");
  const { documentTemplates } = await getOrgCollections();
  const docs = await documentTemplates.find({ orgId: toObjectId(orgId), templateKey }).sort({ version: -1 }).toArray();
  if (!docs.length) return { error: "Template not found.", status: 404 };
  return { versions: docs.map(publicShape) };
}

function slug(name) {
  const base = String(name || "template").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "template";
  return `${base}-${randomBytes(3).toString("hex")}`;
}

export async function createTemplate({ orgId, spec, cloneFromTemplateId, name, membership, actorEmail }) {
  const denied = gate(membership); if (denied) return denied;
  let source = spec;
  if (cloneFromTemplateId) {
    const got = await getTemplate({ orgId, templateId: cloneFromTemplateId });
    if (got.error) return got;
    source = { ...got.template.spec, ...(name ? { name } : {}) };
  }
  const v = validateTemplateSpec(source);
  if (!v.valid) return { error: `Invalid template: ${v.errors.slice(0, 8).join(" ")}`, status: 400, errors: v.errors };
  const { documentTemplates } = await getOrgCollections();
  if ((await documentTemplates.countDocuments({ orgId: toObjectId(orgId) })) >= MAX_TEMPLATES_PER_ORG * 4) return { error: "This organization has reached its template limit.", status: 409 };

  const templateKey = slug(v.spec.name);
  const version = await nextVersion(orgId, templateKey);
  const now = new Date().toISOString();
  const doc = { orgId: toObjectId(orgId), templateKey, version, versionLabel: `${version}.0.0`, documentType: v.spec.documentType, name: v.spec.name, status: "DRAFT", spec: v.spec, specHash: v.specHash, ownerEmail: actorEmail, changeNote: cloneFromTemplateId ? `Cloned from ${cloneFromTemplateId}` : null, createdAt: now, updatedAt: now, publishedAt: null, archivedAt: null };
  const { insertedId } = await documentTemplates.insertOne(doc);
  await logOrgActivity({ orgId, recordType: "DOCUMENT_TEMPLATE", recordId: insertedId, actorEmail, action: "TEMPLATE_CREATED", previousState: null, newState: "DRAFT", metadata: { templateKey, version, documentType: doc.documentType, specHash: doc.specHash } });
  return { template: publicShape({ ...doc, _id: insertedId }) };
}

export async function createTemplateVersion({ orgId, templateId, spec, changeNote, membership, actorEmail }) {
  const denied = gate(membership); if (denied) return denied;
  if (!templateId?.startsWith("org:")) return { error: "System templates cannot be versioned; clone one first.", status: 400 };
  const templateKey = templateId.slice(4);
  const { documentTemplates } = await getOrgCollections();
  const latest = await documentTemplates.find({ orgId: toObjectId(orgId), templateKey }).sort({ version: -1 }).limit(1).next();
  if (!latest) return { error: "Template not found.", status: 404 };
  if ((await documentTemplates.countDocuments({ orgId: toObjectId(orgId), templateKey })) >= MAX_VERSIONS_PER_TEMPLATE) return { error: "This template has reached its version limit.", status: 409 };
  const v = validateTemplateSpec(spec, { expectedType: latest.documentType });
  if (!v.valid) return { error: `Invalid template: ${v.errors.slice(0, 8).join(" ")}`, status: 400, errors: v.errors };
  const version = await nextVersion(orgId, templateKey);
  const now = new Date().toISOString();
  const doc = { orgId: toObjectId(orgId), templateKey, version, versionLabel: `${version}.0.0`, documentType: latest.documentType, name: v.spec.name, status: "DRAFT", spec: v.spec, specHash: v.specHash, ownerEmail: actorEmail, changeNote: changeNote ? String(changeNote).slice(0, 300) : null, createdAt: now, updatedAt: now, publishedAt: null, archivedAt: null };
  const { insertedId } = await documentTemplates.insertOne(doc);
  await logOrgActivity({ orgId, recordType: "DOCUMENT_TEMPLATE", recordId: insertedId, actorEmail, action: "TEMPLATE_CREATED", previousState: null, newState: "DRAFT", metadata: { templateKey, version, documentType: doc.documentType, specHash: doc.specHash } });
  return { template: publicShape({ ...doc, _id: insertedId }) };
}

/** A DRAFT can be edited in place; a PUBLISHED/ARCHIVED version never can. */
export async function updateTemplateDraft({ orgId, templateId, version, spec, changeNote, membership, actorEmail }) {
  const denied = gate(membership); if (denied) return denied;
  if (!templateId?.startsWith("org:")) return { error: "System templates are immutable.", status: 400 };
  const templateKey = templateId.slice(4);
  const { documentTemplates } = await getOrgCollections();
  const existing = await documentTemplates.findOne({ orgId: toObjectId(orgId), templateKey, version: Number(version) });
  if (!existing) return { error: "Template not found.", status: 404 };
  if (existing.status !== "DRAFT") return { error: `This version is ${existing.status} and can no longer be edited. Create a new version instead.`, status: 409 };
  const v = validateTemplateSpec(spec, { expectedType: existing.documentType });
  if (!v.valid) return { error: `Invalid template: ${v.errors.slice(0, 8).join(" ")}`, status: 400, errors: v.errors };
  const now = new Date().toISOString();
  const updated = await documentTemplates.findOneAndUpdate(
    { _id: existing._id, status: "DRAFT" },
    { $set: { spec: v.spec, specHash: v.specHash, name: v.spec.name, updatedAt: now, ...(changeNote !== undefined ? { changeNote: String(changeNote || "").slice(0, 300) || null } : {}) } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "This version was published while you were editing it.", status: 409 };
  await logOrgActivity({ orgId, recordType: "DOCUMENT_TEMPLATE", recordId: existing._id, actorEmail, action: "TEMPLATE_UPDATED", previousState: "DRAFT", newState: "DRAFT", metadata: { templateKey, version: existing.version, specHash: v.specHash } });
  return { template: publicShape(updated) };
}

export async function publishTemplate({ orgId, templateId, version, membership, actorEmail }) {
  const denied = gate(membership); if (denied) return denied;
  if (!templateId?.startsWith("org:")) return { error: "System templates are already published.", status: 400 };
  const templateKey = templateId.slice(4);
  const { documentTemplates } = await getOrgCollections();
  const existing = await documentTemplates.findOne({ orgId: toObjectId(orgId), templateKey, version: Number(version) });
  if (!existing) return { error: "Template not found.", status: 404 };
  // Re-validate at publish: the stored spec must still satisfy the current rules.
  const v = validateTemplateSpec(existing.spec, { expectedType: existing.documentType });
  if (!v.valid) return { error: `Cannot publish an invalid template: ${v.errors.slice(0, 6).join(" ")}`, status: 400, errors: v.errors };
  const now = new Date().toISOString();
  const published = await documentTemplates.findOneAndUpdate(
    { _id: existing._id, status: "DRAFT" },
    { $set: { status: "PUBLISHED", publishedAt: now, publishedByEmail: actorEmail, specHash: v.specHash, spec: v.spec, updatedAt: now } },
    { returnDocument: "after" }
  );
  if (!published) return { error: `This version is ${existing.status}; only a draft can be published.`, status: 409 };
  await logOrgActivity({ orgId, recordType: "DOCUMENT_TEMPLATE", recordId: existing._id, actorEmail, action: "TEMPLATE_PUBLISHED", previousState: "DRAFT", newState: "PUBLISHED", metadata: { templateKey, version: existing.version, specHash: v.specHash } });
  return { template: publicShape(published) };
}

export async function archiveTemplate({ orgId, templateId, version, membership, actorEmail }) {
  const denied = gate(membership); if (denied) return denied;
  if (!templateId?.startsWith("org:")) return { error: "System templates cannot be archived.", status: 400 };
  const templateKey = templateId.slice(4);
  const { documentTemplates } = await getOrgCollections();
  const now = new Date().toISOString();
  const query = { orgId: toObjectId(orgId), templateKey, status: { $in: ["DRAFT", "PUBLISHED"] } };
  if (version !== undefined && version !== null) query.version = Number(version);
  const existing = await documentTemplates.find(query).toArray();
  if (!existing.length) return { error: "Template not found or already archived.", status: 404 };
  await documentTemplates.updateMany(query, { $set: { status: "ARCHIVED", archivedAt: now, updatedAt: now } });
  for (const t of existing) await logOrgActivity({ orgId, recordType: "DOCUMENT_TEMPLATE", recordId: t._id, actorEmail, action: "TEMPLATE_ARCHIVED", previousState: t.status, newState: "ARCHIVED", metadata: { templateKey, version: t.version } });
  return { archived: existing.length };
}

/** Picks the template for a document: explicit id > org default for the
 *  type > the system default. Returns the exact version + spec + hash that
 *  will be recorded on the document. */
export async function resolveTemplate({ orgId, documentType, templateId, version, settings, allowDraft = false }) {
  const chosen = templateId || settings?.defaults?.templateByType?.[documentType] || DEFAULT_TEMPLATE_BY_TYPE[documentType];
  if (!chosen) return { error: `No template is available for "${documentType}".`, status: 400 };
  const got = await getTemplate({ orgId, templateId: chosen, version, allowDraft });
  if (got.error) return got;
  if (got.template.documentType !== documentType) return { error: `That template is for ${got.template.documentType}, not ${documentType}.`, status: 400 };
  if (got.template.status === "ARCHIVED") return { error: "That template version is archived; choose a published one.", status: 409 };
  return got;
}

export { SYSTEM_TEMPLATES };
