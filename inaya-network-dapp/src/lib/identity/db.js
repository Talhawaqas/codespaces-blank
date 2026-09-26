// src/lib/identity/db.js
//
// Identity Integration SOW: collections and indexes. Every collection carries orgId (or, for MSP links and MSP
// credentials, the MSP org id) and every query in this module filters on it. Runs live in `identity_runs`, which is
// registered in orgs.js because a run is an Evidence Graph subject.

import { connectToDatabase } from "../mongodb.js";
import { getOrgCollections } from "../orgs.js";

export const IDENTITY_COLLECTIONS = [
  "identityProviders", "identityExternalUsers", "identityMappings", "identityGrants", "identityEvents", "identityCredentials",
  "identityMspLinks", "identityMspInvites", "identityMspAssignments", "identityReviews", "identityReviewItems", "identityDriftReports",
  "identityJobs", "identitySnapshots", "identityRevocations", "identityRemediations", "identityLocks", "identityWebhooks", "identityDeliveries",
];

const NAMES = {
  identityProviders: "identity_providers", identityExternalUsers: "identity_external_users", identityMappings: "identity_mappings",
  identityGrants: "identity_grants", identityEvents: "identity_events", identityCredentials: "identity_credentials",
  identityMspLinks: "identity_msp_links", identityMspInvites: "identity_msp_invites", identityMspAssignments: "identity_msp_assignments",
  identityReviews: "identity_reviews", identityReviewItems: "identity_review_items", identityDriftReports: "identity_drift_reports",
  identityJobs: "identity_jobs", identitySnapshots: "identity_snapshots", identityRevocations: "identity_revocations",
  identityRemediations: "identity_remediations", identityLocks: "identity_locks", identityWebhooks: "identity_webhooks", identityDeliveries: "identity_deliveries",
};

export async function getIdentityCollections() {
  const { db } = await connectToDatabase();
  const out = { db };
  for (const k of IDENTITY_COLLECTIONS) out[k] = db.collection(NAMES[k]);
  const org = await getOrgCollections();
  out.identityRuns = org.identityRuns;
  out.orgMembers = org.orgMembers;
  return out;
}

let ensured = false;
export async function ensureIdentityIndexes() {
  if (ensured) return;
  const c = await getIdentityCollections();
  await Promise.all([
    // one provider tenant belongs to exactly one organization: a second claim is refused by the database itself
    c.identityProviders.createIndex({ kind: 1, providerTenantId: 1 }, { unique: true }),
    c.identityProviders.createIndex({ orgId: 1, status: 1 }),
    c.identityExternalUsers.createIndex({ providerId: 1, externalObjectId: 1 }, { unique: true }),
    c.identityExternalUsers.createIndex({ orgId: 1, inayaEmail: 1 }),
    c.identityExternalUsers.createIndex({ orgId: 1, providerId: 1, employeeId: 1 }),
    c.identityExternalUsers.createIndex({ orgId: 1, email: 1 }),
    c.identityMappings.createIndex({ orgId: 1, active: 1 }),
    c.identityGrants.createIndex({ orgId: 1, email: 1, status: 1 }),
    c.identityGrants.createIndex({ status: 1, expiresAt: 1 }),
    c.identityEvents.createIndex({ providerId: 1, eventId: 1 }, { unique: true }),
    c.identityEvents.createIndex({ orgId: 1, receivedAt: -1 }),
    c.identityCredentials.createIndex({ tokenHash: 1 }, { unique: true }),
    c.identityCredentials.createIndex({ orgId: 1, revokedAt: 1 }),
    c.identityMspLinks.createIndex({ mspOrgId: 1, customerOrgId: 1 }, { unique: true }),
    c.identityMspInvites.createIndex({ tokenHash: 1 }, { unique: true }),
    c.identityMspInvites.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    c.identityMspAssignments.createIndex({ mspOrgId: 1, email: 1 }, { unique: true }),
    c.identityReviews.createIndex({ orgId: 1, status: 1 }),
    c.identityReviewItems.createIndex({ reviewId: 1, email: 1 }, { unique: true }),
    c.identityDriftReports.createIndex({ orgId: 1, generatedAt: -1 }),
    c.identityJobs.createIndex({ status: 1, nextRunAt: 1 }),
    c.identityJobs.createIndex({ orgId: 1, createdAt: -1 }),
    c.identitySnapshots.createIndex({ orgId: 1, providerId: 1, snapshotId: 1 }),
    c.identitySnapshots.createIndex({ createdAt: 1 }, { expireAfterSeconds: 7 * 86400 }),
    c.identityRevocations.createIndex({ orgId: 1, email: 1, createdAt: -1 }),
    c.identityRemediations.createIndex({ orgId: 1, status: 1, kind: 1 }),
    c.identityRemediations.dropIndex("orgId_1_dedupeKey_1").catch(() => {}).then(() => c.identityRemediations.createIndex({ orgId: 1, kind: 1, recordId: 1 }, { unique: true, partialFilterExpression: { status: "OPEN" } })),
    c.identityWebhooks.createIndex({ orgId: 1, active: 1 }),
    c.identityDeliveries.createIndex({ status: 1, nextAttemptAt: 1 }),
    c.identityDeliveries.createIndex({ webhookId: 1, eventId: 1 }, { unique: true }),
    c.identityDeliveries.createIndex({ createdAt: 1 }, { expireAfterSeconds: 30 * 86400 }),
    c.identityLocks.createIndex({ key: 1 }, { unique: true }),
    c.identityLocks.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    c.identityRuns.createIndex({ orgId: 1, createdAt: -1 }),
    c.identityRuns.createIndex({ orgId: 1, email: 1, createdAt: -1 }),
    c.identityRuns.createIndex({ state: 1, nextRetryAt: 1 }),
  ]);
  ensured = true;
}
