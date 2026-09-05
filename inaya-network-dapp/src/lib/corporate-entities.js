// src/lib/corporate-entities.js
//
// Healthcare & Legal Expansion SOW, Phase 8 (§11.27) — corporate legal
// entities. Plain CRUD (no state machine — the SOW doesn't define
// lifecycle transitions for entities themselves, just fields to track).

import { getOrgCollections, toObjectId } from "./orgs.js";
import { canAccessLegalMatters } from "./orgGates.js";
import { logOrgActivity } from "./org-activity-log.js";

export async function createEntity({ orgId, name, jurisdiction, entityType, parentEntityId, directorsOfficers, formationDocumentId, actorEmail, membership }) {
  if (!canAccessLegalMatters(membership)) return { error: "You don't have permission to add a corporate entity.", status: 403 };
  const { legalEntities } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), name, jurisdiction: jurisdiction || null, entityType: entityType || null,
    parentEntityId: parentEntityId ? toObjectId(parentEntityId) : null, directorsOfficers: directorsOfficers || [],
    formationDocumentId: formationDocumentId ? toObjectId(formationDocumentId) : null,
    annualFilings: [], resolutions: [],
    createdByEmail: actorEmail, createdAt: now, updatedAt: now,
  };
  const result = await legalEntities.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };
  await logOrgActivity({ orgId, recordType: "CORPORATE_ENTITY", recordId: inserted._id, actorEmail, action: "CREATED", previousState: null, newState: null, metadata: { name, jurisdiction } });
  return { entity: inserted };
}

export async function recordAnnualFiling({ orgId, entityId, filingType, filedDate, documentId, actorEmail, membership }) {
  if (!canAccessLegalMatters(membership)) return { error: "You don't have permission to record a filing.", status: 403 };
  const { legalEntities } = await getOrgCollections();
  const updated = await legalEntities.findOneAndUpdate(
    { _id: toObjectId(entityId), orgId: toObjectId(orgId) },
    { $push: { annualFilings: { filingType, filedDate, documentId: documentId ? toObjectId(documentId) : null, recordedByEmail: actorEmail, recordedAt: new Date().toISOString() } }, $set: { updatedAt: new Date().toISOString() } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "Entity not found.", status: 404 };
  return { entity: updated };
}

export async function recordResolution({ orgId, entityId, description, documentId, actorEmail, membership }) {
  if (!canAccessLegalMatters(membership)) return { error: "You don't have permission to record a resolution.", status: 403 };
  const { legalEntities } = await getOrgCollections();
  const updated = await legalEntities.findOneAndUpdate(
    { _id: toObjectId(entityId), orgId: toObjectId(orgId) },
    { $push: { resolutions: { description, documentId: documentId ? toObjectId(documentId) : null, recordedByEmail: actorEmail, recordedAt: new Date().toISOString() } }, $set: { updatedAt: new Date().toISOString() } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "Entity not found.", status: 404 };
  return { entity: updated };
}

export async function listEntities(orgId) {
  const { legalEntities } = await getOrgCollections();
  return legalEntities.find({ orgId: toObjectId(orgId) }).sort({ name: 1 }).toArray();
}
