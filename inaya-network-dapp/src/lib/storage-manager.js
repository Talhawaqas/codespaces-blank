// src/lib/storage-manager.js
//
// Four High-Impact Business Workspace Extensions SOW — Feature 2: Native
// DePIN Storage Allocation Dashboard.
//
// STATUS — Live: real allocation/usage (orgPlans.js), real replica/pin
// health (backupEngine.js/resilience-status.js — nothing here re-derives
// health from scratch), enterprise-owned-node control plane (registration
// + health/capacity reporting + eligibility). Unsupported: geographic
// region routing (confirmed — no pinning provider routes by region today;
// see data-residency.js's header comment on the new preference fields) and
// actual shard routing to an enterprise-owned node (the storage backend
// has no routing-by-node concept yet) — both are explicitly NEVER shown as
// "Active," only "Declared" or "Unsupported," per this SOW's own rule
// against exposing a control the network can't enforce.

import { getOrgCollections, toObjectId, canManageOrg } from "./orgs.js";
import { logOrgActivity } from "./org-activity-log.js";
import { getOrgPlan, getOrgUsage } from "./orgPlans.js";
import { getBackupStatus, getTargetReplicaCount } from "./backupEngine.js";
import { getResilienceStatus } from "./resilience-status.js";

const MAX_DOCUMENTS_SAMPLED = 200; // bounds the per-document backup-status fan-out below

/** The dashboard's primary payload: real allocation, real replication
 *  health (sampled, capped), and the org's resilience-policy state if any
 *  policy exists (Autonomous Resilience Layer SOW's own module, reused
 *  as-is). */
export async function getOrgStorageOverview(orgId) {
  const { orgs, orgDocuments } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const org = await orgs.findOne({ _id: orgObjectId });
  const plan = getOrgPlan(org);
  const usage = await getOrgUsage(orgId);

  const docs = await orgDocuments
    .find({ orgId: orgObjectId, deletedAt: null }, { projection: { fileHash: 1 } })
    .limit(MAX_DOCUMENTS_SAMPLED)
    .toArray();
  const totalDocumentCount = await orgDocuments.countDocuments({ orgId: orgObjectId, deletedAt: null });

  let fullyReplicated = 0, degraded = 0, atRisk = 0;
  let lastTelemetrySyncAt = null;
  for (const doc of docs) {
    const status = await getBackupStatus(doc.fileHash);
    const shards = [status.shardAlpha, status.shardBeta];
    let worst = "fullyReplicated";
    for (const shard of shards) {
      const healthyReplicas = shard.replicas.filter((r) => !r.corrupted).length;
      for (const r of shard.replicas) {
        if (r.lastCheckedAt && (!lastTelemetrySyncAt || r.lastCheckedAt > lastTelemetrySyncAt)) lastTelemetrySyncAt = r.lastCheckedAt;
      }
      if (healthyReplicas === 0) worst = "atRisk";
      else if (healthyReplicas < shard.targetReplicaCount && worst !== "atRisk") worst = "degraded";
    }
    if (worst === "fullyReplicated") fullyReplicated += 1;
    else if (worst === "degraded") degraded += 1;
    else atRisk += 1;
  }

  const resilience = await getResilienceStatus(orgId);

  return {
    allocation: {
      planName: plan.name, maxStorageGB: plan.maxStorageGB === Infinity ? null : plan.maxStorageGB,
      usedBytes: usage.storageUsedBytes, availableBytes: plan.maxStorageGB === Infinity ? null : plan.maxStorageGB * 1073741824 - usage.storageUsedBytes,
    },
    replication: {
      targetReplicaCount: getTargetReplicaCount(),
      documentsSampled: docs.length, totalDocumentCount, truncated: totalDocumentCount > MAX_DOCUMENTS_SAMPLED,
      fullyReplicated, degraded, atRisk,
      lastTelemetrySyncAt,
    },
    resiliencePolicies: resilience.policies,
  };
}

// ============================================================
// Enterprise-owned nodes — control plane only. No live daemon integration
// exists for org-scoped nodes (confirmed: the public node-operator program
// at api/nodes/register has no orgId concept at all) — this is new,
// additive infrastructure. Actual shard routing to a registered node is
// intentionally NOT implemented; `eligibility` always reads "routing not
// yet supported" regardless of a node's own health.
// ============================================================

export async function registerOrgStorageNode({ orgId, nodeWallet, capacityGB, membership, actorEmail }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can register a storage node.", status: 403 };
  if (!nodeWallet || !Number.isFinite(Number(capacityGB)) || Number(capacityGB) <= 0) {
    return { error: "nodeWallet and a positive capacityGB are required.", status: 400 };
  }

  const { orgStorageNodes } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const wallet = String(nodeWallet).trim().toLowerCase();

  const existing = await orgStorageNodes.findOne({ orgId: orgObjectId, nodeWallet: wallet });
  if (existing) return { error: "This wallet is already registered as a storage node for this organization.", status: 409 };

  const now = new Date().toISOString();
  const result = await orgStorageNodes.insertOne({
    orgId: orgObjectId, nodeWallet: wallet, capacityGB: Number(capacityGB),
    registeredAt: now, lastHeartbeatAt: null, status: "REGISTERED",
    eligibility: "routing_not_yet_supported", // honest, static -- see module header
    registeredByEmail: actorEmail,
  });

  await logOrgActivity({ orgId: orgObjectId, recordType: "ORG_STORAGE_NODE", recordId: result.insertedId, actorEmail, action: "STORAGE_NODE_REGISTERED", previousState: null, newState: "REGISTERED", metadata: { nodeWallet: wallet, capacityGB } });
  return { nodeId: result.insertedId };
}

export async function listOrgStorageNodes(orgId) {
  const { orgStorageNodes } = await getOrgCollections();
  return orgStorageNodes.find({ orgId: toObjectId(orgId) }).sort({ registeredAt: -1 }).toArray();
}

/** A registered node's own operator can report health/capacity -- this is
 *  the one write path that could later be wired to a real daemon, but
 *  nothing calls it automatically today (no daemon exists for org-scoped
 *  nodes yet). Never flips `eligibility` to anything implying routing is
 *  live. */
export async function reportOrgStorageNodeHealth({ orgId, nodeId, capacityGB, healthy }) {
  const { orgStorageNodes } = await getOrgCollections();
  const now = new Date().toISOString();
  const updated = await orgStorageNodes.findOneAndUpdate(
    { _id: toObjectId(nodeId), orgId: toObjectId(orgId) },
    { $set: { lastHeartbeatAt: now, status: healthy ? "HEALTHY" : "DEGRADED", ...(Number.isFinite(Number(capacityGB)) ? { capacityGB: Number(capacityGB) } : {}) } },
    { returnDocument: "after" }
  );
  if (!updated) return { error: "Storage node not found.", status: 404 };
  return { node: updated };
}

// ============================================================
// Storage policy — versioned, copying compliancePolicies' {orgId,key,version}
// pattern exactly (see orgs.js's storagePolicies index).
// ============================================================

export async function createStoragePolicy({ orgId, key, dataClassification, allowedRegions, preferredClusters, replicationRequirement, membership, actorEmail }) {
  if (!canManageOrg(membership)) return { error: "Only the owner or an admin can define a storage policy.", status: 403 };
  if (!key) return { error: "A policy key is required.", status: 400 };

  const { storagePolicies } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const latest = await storagePolicies.find({ orgId: orgObjectId, key }).sort({ version: -1 }).limit(1).toArray();
  const nextVersion = (latest[0]?.version || 0) + 1;

  const now = new Date().toISOString();
  const result = await storagePolicies.insertOne({
    orgId: orgObjectId, key, version: nextVersion,
    dataClassification: dataClassification || null, allowedRegions: allowedRegions || [],
    preferredClusters: preferredClusters || [], replicationRequirement: replicationRequirement || null,
    createdByEmail: actorEmail, createdAt: now,
  });

  await logOrgActivity({ orgId: orgObjectId, recordType: "STORAGE_POLICY", recordId: result.insertedId, actorEmail, action: "STORAGE_POLICY_CREATED", previousState: null, newState: null, metadata: { key, version: nextVersion } });
  return { policyId: result.insertedId, version: nextVersion };
}

export async function getLatestStoragePolicy({ orgId, key }) {
  const { storagePolicies } = await getOrgCollections();
  const rows = await storagePolicies.find({ orgId: toObjectId(orgId), key }).sort({ version: -1 }).limit(1).toArray();
  return rows[0] || null;
}

export async function listStoragePolicies(orgId) {
  const { storagePolicies } = await getOrgCollections();
  return storagePolicies.find({ orgId: toObjectId(orgId) }).sort({ key: 1, version: -1 }).toArray();
}
