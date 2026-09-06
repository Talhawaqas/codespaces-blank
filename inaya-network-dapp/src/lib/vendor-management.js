// src/lib/vendor-management.js
//
// Healthcare & Legal Expansion SOW, Phase 1 (§4.12) — vendor management.
// SOW explicit instruction: "Do not automatically label vendors compliant"
// — there is deliberately NO `compliant: boolean` field or derived status
// anywhere in this file. `securityReviewStatus` is a plain org-entered
// string (e.g. "not_reviewed" | "in_review" | "reviewed"), never computed
// or defaulted to imply compliance.
//
// Financial Services & Regulated Enterprise SOW, Phase 5 (§64-66) —
// extended in place (same collection, richer fields) rather than forked:
// a full onboarding state machine (§65) following
// financial-counterparties.js's exact ONBOARDING_STATES/TRANSITIONS
// precedent, the registry fields §64 asks for (criticality/jurisdictions/
// subprocessors/SOC reports/etc.), and continuous monitoring (§66) —
// certificate/contract expiry checks mirror compliance-evidence.js's
// listExpiringEvidence() discipline, and findings/subprocessor changes are
// append-only logs, never edited in place.

import { getOrgCollections, toObjectId, canManageOrg } from "./orgs.js";
import { logOrgActivity } from "./org-activity-log.js";

export const VENDOR_CRITICALITY = ["low", "medium", "high", "critical"];

export const VENDOR_ONBOARDING_STATES = [
  "REQUESTED", "SECURITY_QUESTIONNAIRE", "EVIDENCE", "RISK_ASSESSMENT",
  "LEGAL_REVIEW", "PROCUREMENT", "APPROVED", "CONTRACTED", "MONITORING", "REJECTED",
];
export const VENDOR_ONBOARDING_TRANSITIONS = {
  sendQuestionnaire: { from: "REQUESTED", to: "SECURITY_QUESTIONNAIRE", activityAction: "QUESTIONNAIRE_SENT" },
  submitEvidence: { from: "SECURITY_QUESTIONNAIRE", to: "EVIDENCE", activityAction: "EVIDENCE_REQUESTED" },
  submitForRiskAssessment: { from: "EVIDENCE", to: "RISK_ASSESSMENT", activityAction: "RISK_ASSESSMENT_STARTED" },
  submitForLegalReview: { from: "RISK_ASSESSMENT", to: "LEGAL_REVIEW", activityAction: "LEGAL_REVIEW_STARTED" },
  submitForProcurement: { from: "LEGAL_REVIEW", to: "PROCUREMENT", activityAction: "PROCUREMENT_STARTED" },
  approve: { from: "PROCUREMENT", to: "APPROVED", activityAction: "APPROVED" },
  reject: { from: ["SECURITY_QUESTIONNAIRE", "EVIDENCE", "RISK_ASSESSMENT", "LEGAL_REVIEW", "PROCUREMENT"], to: "REJECTED", activityAction: "REJECTED" },
  contract: { from: "APPROVED", to: "CONTRACTED", activityAction: "CONTRACTED" },
  beginMonitoring: { from: "CONTRACTED", to: "MONITORING", activityAction: "MONITORING_STARTED" },
};

export async function createVendor({ orgId, name, service, criticality, dataCategories, systemsAccessed, jurisdictions, ownerEmail, agreementMetadata, renewalDate, actorEmail, membership }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can add a vendor.", status: 403 };
  if (!name?.trim()) return { error: "A vendor name is required.", status: 400 };
  if (criticality && !VENDOR_CRITICALITY.includes(criticality)) return { error: `Unknown criticality "${criticality}".`, status: 400 };

  const { vendorRecords } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), name, service, criticality: criticality || "medium",
    dataCategories: dataCategories || [], systemsAccessed: systemsAccessed || [], jurisdictions: jurisdictions || [],
    subprocessors: [], contracts: [], dpaOnFile: false,
    securityDocuments: [], socReports: [], isoCertificates: [], penetrationTests: [],
    ownerEmail: ownerEmail || actorEmail, securityReviewStatus: "not_reviewed",
    agreementMetadata: agreementMetadata || {}, renewalDate: renewalDate || null,
    certificateExpiryDates: [], contractExpiryDate: null,
    risk: null, riskScore: null, accessGranted: [], incidentHistory: [], findings: [], subprocessorChangeLog: [],
    slaTarget: null, availabilityTarget: null,
    businessContinuityOnFile: false, recoveryCapabilityNotes: null,
    onboardingStatus: "REQUESTED",
    createdByEmail: actorEmail, createdAt: now, updatedAt: now,
  };
  const result = await vendorRecords.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };
  await logOrgActivity({ orgId, recordType: "VENDOR", recordId: inserted._id, actorEmail, action: "CREATED", previousState: null, newState: "REQUESTED", metadata: { name, service } });
  return { vendor: inserted };
}

export async function updateVendorSecurityReview({ orgId, vendorId, securityReviewStatus, risk, riskScore, actorEmail, membership }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can update a vendor's review status.", status: 403 };
  const { vendorRecords } = await getOrgCollections();
  const current = await vendorRecords.findOne({ _id: toObjectId(vendorId), orgId: toObjectId(orgId) });
  if (!current) return { error: "Vendor not found.", status: 404 };
  const updated = await vendorRecords.findOneAndUpdate(
    { _id: toObjectId(vendorId), orgId: toObjectId(orgId) },
    { $set: { securityReviewStatus, risk: risk ?? current.risk, riskScore: riskScore ?? current.riskScore, updatedAt: new Date().toISOString() } },
    { returnDocument: "after" }
  );
  await logOrgActivity({ orgId, recordType: "VENDOR", recordId: updated._id, actorEmail, action: "REVIEW_UPDATED", previousState: current.securityReviewStatus, newState: securityReviewStatus, metadata: {} });
  return { vendor: updated };
}

export async function transitionVendorOnboarding({ orgId, vendorId, action, actorEmail, membership }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can update vendor onboarding.", status: 403 };
  const definition = VENDOR_ONBOARDING_TRANSITIONS[action];
  if (!definition) return { error: `Unknown action "${action}".`, status: 400 };

  const { vendorRecords } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const vendorObjectId = toObjectId(vendorId);
  const now = new Date().toISOString();
  const fromFilter = Array.isArray(definition.from) ? { $in: definition.from } : definition.from;

  const updated = await vendorRecords.findOneAndUpdate(
    { _id: vendorObjectId, orgId: orgObjectId, onboardingStatus: fromFilter },
    { $set: { onboardingStatus: definition.to, updatedAt: now } },
    { returnDocument: "after" }
  );
  if (!updated) {
    const current = await vendorRecords.findOne({ _id: vendorObjectId, orgId: orgObjectId });
    if (!current) return { error: "Vendor not found.", status: 404 };
    return { error: `This vendor can't take action "${action}" from its current state (${current.onboardingStatus}).`, status: 409 };
  }

  await logOrgActivity({ orgId, recordType: "VENDOR", recordId: updated._id, actorEmail, action: definition.activityAction, previousState: null, newState: definition.to, metadata: {} });
  return { vendor: updated };
}

/** Append-only findings log -- a finding is never deleted, only ever
 *  added to, matching control-testing.js's Finding discipline. */
export async function recordVendorFinding({ orgId, vendorId, description, severity, actorEmail, membership }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can record a vendor finding.", status: 403 };
  if (!description?.trim()) return { error: "A description is required.", status: 400 };
  const { vendorRecords } = await getOrgCollections();
  const now = new Date().toISOString();
  const finding = { description: description.trim(), severity: severity || "medium", recordedByEmail: actorEmail, recordedAt: now };

  const updated = await vendorRecords.findOneAndUpdate(
    { _id: toObjectId(vendorId), orgId: toObjectId(orgId) },
    { $push: { findings: finding }, $set: { updatedAt: now } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "Vendor not found.", status: 404 };
  return { vendor: updated };
}

export async function recordSubprocessorChange({ orgId, vendorId, description, actorEmail, membership }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can record a subprocessor change.", status: 403 };
  if (!description?.trim()) return { error: "A description is required.", status: 400 };
  const { vendorRecords } = await getOrgCollections();
  const now = new Date().toISOString();
  const entry = { description: description.trim(), recordedByEmail: actorEmail, recordedAt: now };

  const updated = await vendorRecords.findOneAndUpdate(
    { _id: toObjectId(vendorId), orgId: toObjectId(orgId) },
    { $push: { subprocessorChangeLog: entry }, $set: { updatedAt: now } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "Vendor not found.", status: 404 };
  return { vendor: updated };
}

export async function updateVendorExpiryDates({ orgId, vendorId, certificateExpiryDates, contractExpiryDate, actorEmail, membership }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can update vendor expiry dates.", status: 403 };
  const { vendorRecords } = await getOrgCollections();
  const setDoc = { updatedAt: new Date().toISOString() };
  if (certificateExpiryDates !== undefined) setDoc.certificateExpiryDates = certificateExpiryDates;
  if (contractExpiryDate !== undefined) setDoc.contractExpiryDate = contractExpiryDate;

  const updated = await vendorRecords.findOneAndUpdate(
    { _id: toObjectId(vendorId), orgId: toObjectId(orgId) },
    { $set: setDoc },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "Vendor not found.", status: 404 };
  return { vendor: updated };
}

/** §66 continuous monitoring — same "surface what's expiring, never
 *  silently roll past it" discipline as compliance-evidence.js's
 *  listExpiringEvidence(). */
export async function listExpiringVendorItems(orgId, { withinDays = 30 } = {}) {
  const { vendorRecords } = await getOrgCollections();
  const vendors = await vendorRecords.find({ orgId: toObjectId(orgId) }).toArray();
  const cutoff = new Date(Date.now() + withinDays * 24 * 60 * 60 * 1000);
  const now = new Date();

  const expiring = [];
  for (const v of vendors) {
    if (v.contractExpiryDate && new Date(v.contractExpiryDate) <= cutoff) {
      expiring.push({ vendorId: v._id, vendorName: v.name, itemType: "contract", expiresAt: v.contractExpiryDate, alreadyExpired: new Date(v.contractExpiryDate) < now });
    }
    for (const certExpiry of v.certificateExpiryDates || []) {
      if (new Date(certExpiry) <= cutoff) {
        expiring.push({ vendorId: v._id, vendorName: v.name, itemType: "certificate", expiresAt: certExpiry, alreadyExpired: new Date(certExpiry) < now });
      }
    }
  }
  return expiring;
}

export async function listVendors(orgId, { onboardingStatus, criticality } = {}) {
  const { vendorRecords } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId) };
  if (onboardingStatus) query.onboardingStatus = onboardingStatus;
  if (criticality) query.criticality = criticality;
  return vendorRecords.find(query).sort({ name: 1 }).toArray();
}
