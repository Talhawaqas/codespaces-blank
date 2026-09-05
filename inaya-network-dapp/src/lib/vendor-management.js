// src/lib/vendor-management.js
//
// Healthcare & Legal Expansion SOW, Phase 1 (§4.12) — vendor management.
// SOW explicit instruction: "Do not automatically label vendors compliant"
// — there is deliberately NO `compliant: boolean` field or derived status
// anywhere in this file. `securityReviewStatus` is a plain org-entered
// string (e.g. "not_reviewed" | "in_review" | "reviewed"), never computed
// or defaulted to imply compliance.

import { getOrgCollections, toObjectId, canManageOrg } from "./orgs.js";
import { logOrgActivity } from "./org-activity-log.js";

export async function createVendor({ orgId, name, service, dataCategories, ownerEmail, agreementMetadata, renewalDate, actorEmail, membership }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can add a vendor.", status: 403 };
  const { vendorRecords } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), name, service, dataCategories: dataCategories || [],
    ownerEmail: ownerEmail || actorEmail, securityReviewStatus: "not_reviewed",
    agreementMetadata: agreementMetadata || {}, renewalDate: renewalDate || null,
    risk: null, accessGranted: [], incidentHistory: [],
    createdByEmail: actorEmail, createdAt: now, updatedAt: now,
  };
  const result = await vendorRecords.insertOne(doc);
  const inserted = { ...doc, _id: result.insertedId };
  await logOrgActivity({ orgId, recordType: "VENDOR", recordId: inserted._id, actorEmail, action: "CREATED", previousState: null, newState: "not_reviewed", metadata: { name, service } });
  return { vendor: inserted };
}

export async function updateVendorSecurityReview({ orgId, vendorId, securityReviewStatus, risk, actorEmail, membership }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can update a vendor's review status.", status: 403 };
  const { vendorRecords } = await getOrgCollections();
  const current = await vendorRecords.findOne({ _id: toObjectId(vendorId), orgId: toObjectId(orgId) });
  if (!current) return { error: "Vendor not found.", status: 404 };
  const updated = await vendorRecords.findOneAndUpdate(
    { _id: toObjectId(vendorId), orgId: toObjectId(orgId) },
    { $set: { securityReviewStatus, risk: risk ?? current.risk, updatedAt: new Date().toISOString() } },
    { returnDocument: "after" }
  );
  await logOrgActivity({ orgId, recordType: "VENDOR", recordId: updated._id, actorEmail, action: "REVIEW_UPDATED", previousState: current.securityReviewStatus, newState: securityReviewStatus, metadata: {} });
  return { vendor: updated };
}

export async function listVendors(orgId) {
  const { vendorRecords } = await getOrgCollections();
  return vendorRecords.find({ orgId: toObjectId(orgId) }).sort({ name: 1 }).toArray();
}
