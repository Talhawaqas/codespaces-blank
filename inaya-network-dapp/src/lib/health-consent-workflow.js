// src/lib/health-consent-workflow.js
//
// Healthcare & Legal Expansion SOW, Phase 3 (§10.18) — patient consent.
// A consent record is scoped by type+purpose (a patient can consent to
// treatment but not to research use of their data, for example) — status
// transitions are per-record, not a single "patient has consented: yes/no"
// flag, since the SOW explicitly lists distinct consent types.

import { getOrgCollections, toObjectId } from "./orgs.js";
import { canAccessHealthRecords } from "./orgGates.js";
import { logConsentChange } from "./health-audit.js";

export const CONSENT_STATES = ["ACTIVE", "WITHDRAWN", "EXPIRED"];

export async function recordConsent({ orgId, patientId, type, purpose, scope, effectiveDate, expiryDate, signerEmail, evidenceDocumentId, actorEmail, membership }) {
  if (!canAccessHealthRecords(membership)) return { error: "You don't have permission to record consent.", status: 403 };
  const { healthConsents } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), patientId: toObjectId(patientId), type, purpose, scope: scope || {},
    effectiveDate: effectiveDate || now, expiryDate: expiryDate || null,
    signerEmail: signerEmail || null, evidence: evidenceDocumentId ? toObjectId(evidenceDocumentId) : null,
    status: "ACTIVE", withdrawnAt: null,
    createdByEmail: actorEmail, createdAt: now, updatedAt: now,
  };
  const result = await healthConsents.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };
  await logConsentChange({ orgId, patientId, actorEmail, action: "RECORDED", metadata: { type, purpose } });
  return { consent: inserted };
}

export async function withdrawConsent({ orgId, consentId, actorEmail, membership }) {
  if (!canAccessHealthRecords(membership)) return { error: "You don't have permission to withdraw consent.", status: 403 };
  const { healthConsents } = await getOrgCollections();
  const now = new Date().toISOString();
  const updated = await healthConsents.findOneAndUpdate(
    { _id: toObjectId(consentId), orgId: toObjectId(orgId), status: "ACTIVE" },
    { $set: { status: "WITHDRAWN", withdrawnAt: now, updatedAt: now } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "Consent record not found, or already withdrawn.", status: 409 };
  await logConsentChange({ orgId, patientId: updated.patientId, actorEmail, action: "WITHDRAWN", metadata: { consentId } });
  return { consent: updated };
}

/** Read-only status check — used to gate a sharing/export/AI-submission
 *  action on whether the required consent type is currently active for a
 *  patient. Returns false for a missing, withdrawn, or expired consent —
 *  fails closed, never assumes consent absent a real ACTIVE record. */
export async function hasActiveConsent({ orgId, patientId, type, purpose }) {
  const { healthConsents } = await getOrgCollections();
  const now = new Date().toISOString();
  const consent = await healthConsents.findOne({
    orgId: toObjectId(orgId), patientId: toObjectId(patientId), type, purpose, status: "ACTIVE",
    $or: [{ expiryDate: null }, { expiryDate: { $gt: now } }],
  });
  return !!consent;
}

export async function listConsentsForPatient(orgId, patientId) {
  const { healthConsents } = await getOrgCollections();
  return healthConsents.find({ orgId: toObjectId(orgId), patientId: toObjectId(patientId) }).sort({ createdAt: -1 }).toArray();
}
