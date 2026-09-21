// src/lib/dataRoomTemplates.js
//
// Modular Enterprise Adoption Features SOW, Feature 2 -- Zero-Knowledge
// Data Room Templates. Per the SOW's own §7.1/§7.3: a TEMPLATE is
// configuration (name, section list, NDA requirement, default access
// window), not a new storage/sharing system. Rooms themselves are still
// created and served entirely by external-data-room.js (org isolation,
// magic links, session/NDA gating, access logging) -- this file only
// adds a reusable, cloneable shape a room can be instantiated from.
//
// ZERO-KNOWLEDGE TERMINOLOGY (SOW §7.5) -- stated plainly, not implied:
// the DOCUMENTS a room references are genuinely end-to-end encrypted --
// they're ordinary org_documents rows, encrypted client-side before
// upload exactly like every other Business Workspace document, and this
// file never touches that content. The ROOM METADATA (its name, section
// list, NDA requirement, which document IDs are in it, who was invited,
// the access log) is NOT zero-knowledge -- it is ordinary server-visible
// data, the same way any permission system's own bookkeeping must be
// server-visible to enforce access control at all. A room is
// confidential and access-controlled; it is not an unreadable ledger.

import { getOrgCollections, canManageOrg, toObjectId } from "./orgs.js";
import { logOrgActivity } from "./org-activity-log.js";
import { createDataRoom, ROOM_TYPES } from "./external-data-room.js";

// The SOW's own four named examples (§7.2), available to every org to
// clone without having to retype them. Not org data themselves -- cloning
// copies these into a real, editable org-owned template document.
export const BUILTIN_TEMPLATES = {
  fundraising: {
    name: "Fundraising / Investor Data Room",
    description: "A structured room for sharing company, financial, legal, and product materials with prospective investors.",
    roomType: "investor",
    sections: ["Company", "Corporate", "Financial", "Legal", "Product", "Security", "IP", "Team"],
    ndaRequired: true,
  },
  ma: {
    name: "M&A Data Room",
    description: "A structured room for buy-side/sell-side due diligence covering corporate, financial, contractual, and operational records.",
    roomType: "diligence",
    sections: ["Corporate", "Financial", "Contracts", "Employees", "Intellectual Property", "Security", "Operations", "Due Diligence"],
    ndaRequired: true,
  },
  legalReview: {
    name: "Legal Review Room",
    description: "A structured room for sharing matter documents, agreements, evidence, and correspondence with outside counsel or a counterparty.",
    roomType: "legal",
    sections: ["Matter documents", "Agreements", "Evidence", "Correspondence", "Supporting records"],
    ndaRequired: false,
  },
  web3DueDiligence: {
    name: "Web3 Project Due-Diligence Room",
    description: "A structured room for sharing architecture, contract, tokenomics, security, and governance evidence with a reviewing counterparty.",
    roomType: "diligence",
    sections: ["Architecture", "Contracts", "Tokenomics", "Security", "Treasury", "Governance", "Deployment evidence"],
    ndaRequired: true,
  },
};

function validateTemplateFields({ name, roomType, sections }) {
  if (!name?.trim()) return "A template name is required.";
  if (!ROOM_TYPES.includes(roomType)) return `Unknown room type "${roomType}".`;
  if (sections !== undefined && !Array.isArray(sections)) return "sections must be an array of strings.";
  return null;
}

export async function createDataRoomTemplate({ orgId, name, description, roomType, sections, ndaRequired, ndaText, defaultAccessExpiryHours, actorEmail, membership }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can create a data room template.", status: 403 };
  const validationError = validateTemplateFields({ name, roomType, sections });
  if (validationError) return { error: validationError, status: 400 };

  const { dataRoomTemplates: templatesCollection } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), name: name.trim(), description: description ? String(description).trim() : null,
    roomType, sections: sections || [], ndaRequired: !!ndaRequired, ndaText: ndaRequired ? (ndaText || null) : null,
    defaultAccessExpiryHours: Number.isFinite(Number(defaultAccessExpiryHours)) ? Number(defaultAccessExpiryHours) : 72,
    clonedFromBuiltin: null, createdByEmail: actorEmail, createdAt: now, updatedAt: now, deletedAt: null,
  };
  const result = await templatesCollection.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };

  await logOrgActivity({ orgId, recordType: "DATA_ROOM_TEMPLATE", recordId: inserted._id, actorEmail, action: "CREATED", previousState: null, newState: null, metadata: { name: doc.name, roomType } });
  return { template: inserted };
}

/** Copies one of the SOW's built-in examples into a real, editable
 *  org-owned template -- a one-step "start from" action rather than
 *  making every org retype the same section lists. */
export async function cloneBuiltinTemplate({ orgId, builtinKey, actorEmail, membership }) {
  const builtin = BUILTIN_TEMPLATES[builtinKey];
  if (!builtin) return { error: `Unknown built-in template "${builtinKey}".`, status: 400 };
  const result = await createDataRoomTemplate({ orgId, ...builtin, actorEmail, membership });
  if (result.error) return result;

  const { dataRoomTemplates: templatesCollection } = await getOrgCollections();
  await templatesCollection.updateOne({ _id: result.template._id }, { $set: { clonedFromBuiltin: builtinKey } });
  return { template: { ...result.template, clonedFromBuiltin: builtinKey } };
}

export async function listDataRoomTemplates(orgId) {
  const { dataRoomTemplates: templatesCollection } = await getOrgCollections();
  return templatesCollection.find({ orgId: toObjectId(orgId), deletedAt: null }).sort({ createdAt: -1 }).toArray();
}

export async function getDataRoomTemplate(orgId, templateId) {
  const { dataRoomTemplates: templatesCollection } = await getOrgCollections();
  return templatesCollection.findOne({ _id: toObjectId(templateId), orgId: toObjectId(orgId), deletedAt: null });
}

/** Editing a template never touches any room already created from it
 *  (SOW's own Data Room test requirement: "template modification without
 *  changing existing rooms") -- a room is a one-time instantiation, not a
 *  live reference back to its template. */
export async function updateDataRoomTemplate({ orgId, templateId, actorEmail, membership, ...fields }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can edit a data room template.", status: 403 };
  const { dataRoomTemplates: templatesCollection } = await getOrgCollections();
  const existing = await getDataRoomTemplate(orgId, templateId);
  if (!existing) return { error: "Template not found.", status: 404 };

  const update = { updatedAt: new Date().toISOString() };
  for (const key of ["name", "description", "sections", "ndaRequired", "ndaText", "defaultAccessExpiryHours"]) {
    if (fields[key] !== undefined) update[key] = fields[key];
  }
  await templatesCollection.updateOne({ _id: existing._id }, { $set: update });
  await logOrgActivity({ orgId, recordType: "DATA_ROOM_TEMPLATE", recordId: existing._id, actorEmail, action: "UPDATED", previousState: null, newState: null, metadata: {} });
  return { template: await getDataRoomTemplate(orgId, templateId) };
}

/** Instantiates a template into a real room -- the one function that
 *  bridges this file into external-data-room.js's own creation path,
 *  never duplicating what createDataRoom() already does. */
export async function createRoomFromTemplate({ orgId, templateId, name, relatedRecordId, actorEmail, membership }) {
  const template = await getDataRoomTemplate(orgId, templateId);
  if (!template) return { error: "Template not found.", status: 404 };

  return createDataRoom({
    orgId, roomType: template.roomType, name: name?.trim() || template.name, relatedRecordId,
    templateId: template._id, sections: template.sections, ndaRequired: template.ndaRequired, ndaText: template.ndaText,
    actorEmail, membership,
  });
}
