// src/lib/nas/appliances.js
//
// Sovereign NAS SOW, Workstream A/T. Registry of NAS appliances (the
// Layer-1 physical/local data plane boundary) -- org-scoped, following
// the exact registry shape established by legacyDataAccess/dataSources.js
// (status states, credential vaulting, health checks).
//
// Reuses the existing storage-resource / Digital Twin model rather than
// building a second one: registering an appliance also creates a
// `storageResources` entry of type "fileShare" tagged with the
// appliance's id, so it participates in the EXISTING
// "STORAGE_RESOURCE_UNAVAILABLE" Digital Twin scenario for free (SOW
// Workstream W) -- no new scenario type, no duplicate entity graph.

import { getOrgCollections, toObjectId } from "../orgs.js";
import { logOrgActivity } from "../org-activity-log.js";
import { canManageNAS, canAccessNAS } from "../orgGates.js";
import { encryptNasSecret, decryptNasSecret, isNasCredentialCryptoConfigured } from "./credentials.js";
import { NasAgentClient } from "./agent.js";
import { createStorageResource, deleteStorageResource } from "../storageResources.js";

export const APPLIANCE_STATUSES = ["UNKNOWN", "REACHABLE", "DEGRADED", "UNREACHABLE"];

async function assertAccess(membership, requireManage) {
  const ok = requireManage ? canManageNAS(membership) : canAccessNAS(membership);
  if (!ok) return { error: requireManage ? "Only a NAS manager can do that." : "You don't have NAS access.", status: 403 };
  return null;
}

/** The only backend this pass implements and validates -- see
 *  agent.js's header for exactly why, and what a production physical
 *  appliance would do instead. */
export const APPLIANCE_BACKENDS = ["wsl-local"];

export async function registerAppliance({ orgId, name, backend, host, adminUsername, adminPassword, membership, actorEmail }) {
  const denied = await assertAccess(membership, true);
  if (denied) return denied;
  if (!name?.trim()) return { error: "name is required.", status: 400 };
  if (!APPLIANCE_BACKENDS.includes(backend)) return { error: `Unknown backend "${backend}". Available: ${APPLIANCE_BACKENDS.join(", ")}.`, status: 400 };
  if (!host?.trim()) return { error: "host is required (the appliance's reachable IP/hostname).", status: 400 };
  if (!isNasCredentialCryptoConfigured()) return { error: "NAS_ENCRYPTION_KEY is not configured on this server.", status: 500 };

  const { nasAppliances } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const now = new Date().toISOString();

  // A real storage-resource entry, reusing the existing IBM Cloud VPC
  // Storage Gap Expansion SOW's model exactly as-is (no fork, no new
  // fields) purely so the NAS appliance is visible to the existing
  // Digital Twin dependency graph and "what if this storage resource
  // becomes unavailable?" scenario. storageResources.js gates this on
  // canManageStorage, a DIFFERENT permission than canManageNAS -- a real
  // NAS manager should not also need an unrelated storage-manager grant
  // just to get Digital Twin visibility for free. The caller has already
  // passed this module's own canManageNAS check above, so this one
  // internal bookkeeping call runs under a synthetic elevated membership,
  // the same {role:"owner"} pattern api-keys.js's requireApiKey() uses
  // for system-level actions that must not be gated by an unrelated
  // subsystem's own permission.
  const storageResourceResult = await createStorageResource({
    orgId, type: "fileShare", name: `NAS: ${name.trim()}`, region: "on-prem", capacity: null,
    performanceProfile: null, tags: { source: "nas-appliance" }, membership: { role: "owner" }, actorEmail,
  });
  if (storageResourceResult.error) return storageResourceResult;

  const doc = {
    orgId: orgObjectId, name: name.trim(), backend, host: host.trim(),
    adminUsername: adminUsername?.trim() || null,
    adminCredential: adminPassword ? encryptNasSecret(adminPassword) : null,
    status: "UNKNOWN", lastHealthCheckAt: null, lastHealthDetail: null,
    // Reused, not forked: the storage-resource's own real S3-compat
    // bucket (created by createStorageResource itself) is where this
    // appliance's backed-up files actually land -- see backup.js.
    storageResourceId: storageResourceResult.resource._id,
    backupBucket: storageResourceResult.resource.backingBucket,
    createdByEmail: actorEmail, createdAt: now, updatedAt: now, deletedAt: null,
  };
  const result = await nasAppliances.insertOne(doc);

  await logOrgActivity({ orgId, recordType: "NAS_APPLIANCE", recordId: result.insertedId, actorEmail, action: "REGISTERED", previousState: null, newState: "UNKNOWN", metadata: { name: doc.name, backend, host: doc.host } });

  const health = await checkApplianceHealth({ orgId, applianceId: result.insertedId.toString(), membership });
  return { appliance: { ...doc, _id: result.insertedId, adminCredential: undefined }, health };
}

export async function listAppliances({ orgId, membership }) {
  const denied = await assertAccess(membership, false);
  if (denied) return denied;
  const { nasAppliances } = await getOrgCollections();
  const rows = await nasAppliances.find({ orgId: toObjectId(orgId), deletedAt: null }, { projection: { adminCredential: 0 } }).sort({ createdAt: -1 }).toArray();
  return { appliances: rows };
}

export async function getAppliance({ orgId, applianceId, membership }) {
  const denied = await assertAccess(membership, false);
  if (denied) return denied;
  const { nasAppliances } = await getOrgCollections();
  const doc = await nasAppliances.findOne({ _id: toObjectId(applianceId), orgId: toObjectId(orgId), deletedAt: null }, { projection: { adminCredential: 0 } });
  if (!doc) return { error: "Appliance not found.", status: 404 };
  return { appliance: doc };
}

export async function checkApplianceHealth({ orgId, applianceId, membership }) {
  const denied = await assertAccess(membership, false);
  if (denied) return denied;
  const { nasAppliances } = await getOrgCollections();
  const doc = await nasAppliances.findOne({ _id: toObjectId(applianceId), orgId: toObjectId(orgId), deletedAt: null });
  if (!doc) return { error: "Appliance not found.", status: 404 };

  const agent = new NasAgentClient({ backend: doc.backend });
  const health = await agent.health(doc.host);
  const status = health.smb.reachable || health.nfs.reachable ? (health.smb.serviceActive && health.nfs.serviceActive ? "REACHABLE" : "DEGRADED") : "UNREACHABLE";

  await nasAppliances.updateOne({ _id: doc._id }, { $set: { status, lastHealthCheckAt: new Date().toISOString(), lastHealthDetail: health } });
  return { status, detail: health };
}

export async function deleteAppliance({ orgId, applianceId, membership, actorEmail }) {
  const denied = await assertAccess(membership, true);
  if (denied) return denied;
  const { nasAppliances, nasShares } = await getOrgCollections();
  const doc = await nasAppliances.findOne({ _id: toObjectId(applianceId), orgId: toObjectId(orgId), deletedAt: null });
  if (!doc) return { error: "Appliance not found.", status: 404 };

  const activeShares = await nasShares.countDocuments({ applianceId: doc._id, deletedAt: null });
  if (activeShares > 0) return { error: `Cannot delete appliance with ${activeShares} active share(s). Delete its shares first.`, status: 409 };

  await nasAppliances.updateOne({ _id: doc._id }, { $set: { deletedAt: new Date().toISOString() } });
  if (doc.storageResourceId) {
    await deleteStorageResource({ orgId, resourceId: doc.storageResourceId.toString(), membership: { role: "owner" }, actorEmail }).catch(() => {});
  }
  await logOrgActivity({ orgId, recordType: "NAS_APPLIANCE", recordId: doc._id, actorEmail, action: "DELETED", previousState: doc.status, newState: "DELETED", metadata: {} });
  return { deleted: true };
}

/** Internal helper for shares.js/users.js -- resolves an appliance and
 *  its decrypted admin credential together, never exposed via any API
 *  route response. */
export async function resolveApplianceForAgent({ orgId, applianceId }) {
  const { nasAppliances } = await getOrgCollections();
  const doc = await nasAppliances.findOne({ _id: toObjectId(applianceId), orgId: toObjectId(orgId), deletedAt: null });
  if (!doc) return null;
  return { appliance: doc, agent: new NasAgentClient({ backend: doc.backend }) };
}
