// src/lib/data-residency.js
//
// Financial Services & Regulated Enterprise SOW, Phase 5 (§72) — Data
// Residency & Sovereignty. Cross-vertical. One policy document per org,
// same single-profile-doc pattern industry-config.js already uses for
// vertical/profile settings -- an org-level POLICY declaration, not a
// per-record enforcement engine. This module records what the
// organization's stated residency/sovereignty policy is; it does not
// itself verify that every stored byte actually complies (that would
// require infrastructure-level controls this SOW pass doesn't build),
// so the policy is presented as a declared control, never as a proof of
// compliance -- the same "controls/evidence, never automatic compliance"
// boundary the whole Phase 4/5 layer holds to.

import { getOrgCollections, toObjectId, canManageOrg } from "./orgs.js";
import { logOrgActivity } from "./org-activity-log.js";

export async function getDataResidencyPolicy(orgId) {
  const { dataResidencyPolicies } = await getOrgCollections();
  return dataResidencyPolicies.findOne({ orgId: toObjectId(orgId) });
}

export async function upsertDataResidencyPolicy({ orgId, country, region, storageProvider, backupProvider, encryptionPolicy, keyManagementPolicy, processingRestrictions, externalTransferRules, actorEmail, membership }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can update the data residency policy.", status: 403 };

  const { dataResidencyPolicies } = await getOrgCollections();
  const now = new Date().toISOString();
  const setDoc = {
    country: country ?? null, region: region ?? null, storageProvider: storageProvider ?? null,
    backupProvider: backupProvider ?? null, encryptionPolicy: encryptionPolicy ?? null,
    keyManagementPolicy: keyManagementPolicy ?? null, processingRestrictions: processingRestrictions ?? null,
    externalTransferRules: externalTransferRules ?? null,
    updatedByEmail: actorEmail, updatedAt: now,
  };
  await dataResidencyPolicies.updateOne(
    { orgId: toObjectId(orgId) },
    { $set: setDoc, $setOnInsert: { orgId: toObjectId(orgId), createdAt: now } },
    { upsert: true }
  );
  const policy = await getDataResidencyPolicy(orgId);
  await logOrgActivity({ orgId, recordType: "DATA_RESIDENCY_POLICY", recordId: policy._id, actorEmail, action: "UPDATED", previousState: null, newState: null, metadata: {} });
  return { policy };
}
