// src/lib/health-research.js
//
// Healthcare & Legal Expansion SOW, Phase 4 (§10.27) — research mode
// foundation. SOW's explicit instruction: "Do not call data 'anonymous'
// without validated methodology" — every dataset created here MUST carry
// a non-empty `deidentificationMethodology` string describing what was
// actually done (e.g. "direct identifiers removed: name, DOB, contacts,
// insurance IDs; dates generalized to month/year"). There is no
// `anonymous: true` flag anywhere in this schema — datasets are described
// by their actual methodology, read by a human, never by a boolean claim.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { canManageHealth } from "./orgGates.js";
import { logOrgActivity } from "./org-activity-log.js";

// Direct-identifier fields stripped by the default methodology — a
// starting point an org can extend, not a claim of regulatory adequacy.
const DEFAULT_STRIPPED_FIELDS = ["legalName", "preferredName", "contacts", "emergencyContact", "insuranceReferences"];

function deidentifyPatientRecord(patient, strippedFields) {
  const copy = { ...patient };
  for (const field of strippedFields) delete copy[field];
  return copy;
}

export async function createResearchDataset({ orgId, name, sourcePatientIds, strippedFields, methodologyNotes, researcherEmails, actorEmail, membership }) {
  if (!canManageHealth(membership)) return { error: "Only a health manager or the owner/admin can create a research dataset.", status: 403 };
  if (!methodologyNotes || !methodologyNotes.trim()) {
    return { error: "A de-identification methodology description is required — datasets cannot be created without documenting what was actually done to the data.", status: 400 };
  }

  const { healthPatients, db } = await getOrgCollections();
  const researchDatasets = db.collection("health_research_datasets");
  const fieldsToStrip = strippedFields && strippedFields.length ? strippedFields : DEFAULT_STRIPPED_FIELDS;

  const sourcePatients = await healthPatients.find({ orgId: toObjectId(orgId), _id: { $in: (sourcePatientIds || []).map((id) => toObjectId(id)) } }).toArray();
  const records = sourcePatients.map((p) => deidentifyPatientRecord(p, fieldsToStrip));

  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), name, version: 1,
    deidentificationMethodology: methodologyNotes.trim(), strippedFields: fieldsToStrip,
    sourceRecordCount: sourcePatients.length, records,
    researcherEmails: researcherEmails || [],
    createdByEmail: actorEmail, createdAt: now, updatedAt: now,
  };
  const result = await researchDatasets.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };
  await logOrgActivity({ orgId, recordType: "RESEARCH_DATASET", recordId: inserted._id, actorEmail, action: "CREATED", previousState: null, newState: null, metadata: { recordCount: records.length, name } });
  return { dataset: inserted };
}

/** A new version is a new, immutable snapshot — never an in-place edit of
 *  a prior version, so a researcher citing "dataset v1" always gets the
 *  exact same data back later. */
export async function createDatasetVersion({ orgId, datasetId, sourcePatientIds, strippedFields, methodologyNotes, actorEmail, membership }) {
  if (!canManageHealth(membership)) return { error: "Only a health manager or the owner/admin can create a dataset version.", status: 403 };
  const { db, healthPatients } = await getOrgCollections();
  const researchDatasets = db.collection("health_research_datasets");
  const previous = await researchDatasets.findOne({ _id: toObjectId(datasetId), orgId: toObjectId(orgId) });
  if (!previous) return { error: "Dataset not found.", status: 404 };

  const fieldsToStrip = strippedFields && strippedFields.length ? strippedFields : previous.strippedFields;
  const sourcePatients = await healthPatients.find({ orgId: toObjectId(orgId), _id: { $in: (sourcePatientIds || []).map((id) => toObjectId(id)) } }).toArray();
  const records = sourcePatients.map((p) => deidentifyPatientRecord(p, fieldsToStrip));

  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), name: previous.name, version: previous.version + 1,
    deidentificationMethodology: (methodologyNotes || previous.deidentificationMethodology).trim(), strippedFields: fieldsToStrip,
    sourceRecordCount: sourcePatients.length, records, researcherEmails: previous.researcherEmails,
    createdByEmail: actorEmail, createdAt: now, updatedAt: now,
  };
  const result = await researchDatasets.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };
  await logOrgActivity({ orgId, recordType: "RESEARCH_DATASET", recordId: inserted._id, actorEmail, action: "NEW_VERSION", previousState: null, newState: null, metadata: { version: inserted.version } });
  return { dataset: inserted };
}

export async function listDatasetVersions(orgId, name) {
  const { db } = await getOrgCollections();
  const researchDatasets = db.collection("health_research_datasets");
  return researchDatasets.find({ orgId: toObjectId(orgId), name }).sort({ version: 1 }).toArray();
}
