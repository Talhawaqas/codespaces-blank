// src/lib/storageResources.js
//
// IBM Cloud VPC Storage Gap Expansion SOW, Workstreams A/B/C/D -- Unified
// Storage Resource Registry, Block Volume control plane, File Share
// control plane, Mount Target management.
//
// GENUINE GAP (confirmed by repo-wide audit before writing this file): no
// generic resource envelope existed anywhere in this codebase -- every
// domain (S3 objects, documents, storage nodes, escrow...) has its own
// bespoke collection. This is the new envelope for the resource TYPES
// this SOW adds that had no home at all: "volume" and "fileShare". It
// does not replace org_documents, the S3-compat bucket/object model, or
// any other existing collection -- those remain exactly as they are.
//
// HONESTY BOUNDARY -- read this before extending the file. The audit
// confirmed Inaya has NO compute/VM/hypervisor runtime of any kind (no
// instance provisioning, nothing a block device could physically attach
// to) and NO multi-client NFS server. Building a real attachable block
// device or a real mountable network filesystem here would mean either
// fabricating a fake compute layer or lying about physical capability --
// both explicitly forbidden by this SOW. So:
//
//   - "volume" is a logical, taggable, resizable storage container backed
//     by a real Inaya S3-compat bucket. Its "attach"/"detach" operations
//     are a real, honest RESERVATION/LOCK mechanism (preventing two
//     declared consumers from believing they own the same volume
//     concurrently) -- not a physical block-device mount. `attachedTo` is
//     a free-text label the caller supplies (e.g. "desktop-app:host-1",
//     "directsync:folder-id"), never a fabricated device path.
//   - "fileShare" is the same kind of logical container, with declared
//     (never physically provisioned) mount-target records. No NFS
//     protocol is implemented; nothing here can actually be mounted by a
//     real NFS client.
//   - Both carry a static `physicalCapability` field (mirrors storage-
//     manager.js's own `eligibility: "routing_not_yet_supported"` idiom)
//     that is never upgraded to imply real physical capability exists.
//   - `performanceProfile` (requested IOPS/throughput) is always stored
//     alongside `enforced: false` -- Inaya's backend cannot enforce an
//     IOPS/throughput guarantee, so this SOW's own instruction ("do not
//     claim physical IOPS or throughput guarantees if the backend cannot
//     enforce them") applies literally.
//   - `region` is a free-text logical label, not a physical geography --
//     the audit confirmed no pinning provider routes by real geography
//     today (see data-residency.js's own header comment, storage-
//     manager.js's identical caveat). Defaults to "default".
//
// Every resource is backed by a real S3-compat bucket (ensureS3Bucket/
// getS3Bucket, reused unchanged) so its actual bytes live in the same,
// already-encrypted, already-tested storage path as everything else --
// this registry is metadata/control-plane only, never a second storage
// backend.

import { ObjectId } from "mongodb";
import { getOrgCollections, toObjectId, canManageStorage, canAccessStorage } from "./orgs.js";
import { logOrgActivity } from "./org-activity-log.js";
import { ensureS3Bucket } from "./s3-compat/store.js";

export const RESOURCE_TYPES = ["volume", "fileShare"];

export const VOLUME_ATTACHMENT_STATES = ["AVAILABLE", "ATTACHING", "ATTACHED", "DETACHING", "ATTACH_FAILED", "DETACH_FAILED"];

const PHYSICAL_CAPABILITY = {
  volume: "logical_only_no_compute_attach", // no VM/hypervisor runtime exists in Inaya to attach a real block device to
  fileShare: "logical_only_no_nfs_server", // no multi-client NFS protocol server exists
};

const MAX_TAG_COUNT = 10;
const MAX_TAG_KEY_LEN = 128;
const MAX_TAG_VALUE_LEN = 256;

/** Same validation shape as s3-compat/store.js's normalizeTags -- generalized
 *  here to apply across every storage-control-plane resource type, not just
 *  S3 objects, since the audit found no cross-resource tag model existed. */
export function normalizeTags(tags) {
  if (!tags) return {};
  const entries = Object.entries(tags);
  if (entries.length > MAX_TAG_COUNT) throw new Error(`A resource may have at most ${MAX_TAG_COUNT} tags.`);
  const normalized = {};
  for (const [key, value] of entries) {
    if (!key || key.length > MAX_TAG_KEY_LEN) throw new Error(`Tag key "${key}" is invalid or too long (max ${MAX_TAG_KEY_LEN}).`);
    const v = String(value ?? "");
    if (v.length > MAX_TAG_VALUE_LEN) throw new Error(`Tag value for "${key}" is too long (max ${MAX_TAG_VALUE_LEN}).`);
    normalized[key] = v;
  }
  return normalized;
}

export function matchesSelector(tags, selector) {
  if (!selector || Object.keys(selector).length === 0) return true;
  return Object.entries(selector).every(([k, v]) => tags?.[k] === v);
}

async function assertAccess(membership, requireManage) {
  const ok = requireManage ? canManageStorage(membership) : canAccessStorage(membership);
  if (!ok) return { error: requireManage ? "Only a storage manager can do that." : "You don't have storage-infrastructure access.", status: 403 };
  return null;
}

// ---------------------------------------------------------------------
// Generic resource CRUD (Workstream A)
// ---------------------------------------------------------------------

export async function createStorageResource({ orgId, type, name, region, capacity, performanceProfile, tags, membership, actorEmail }) {
  const denied = await assertAccess(membership, true);
  if (denied) return denied;
  if (!RESOURCE_TYPES.includes(type)) return { error: `Unknown resource type "${type}". Must be one of: ${RESOURCE_TYPES.join(", ")}.`, status: 400 };
  if (!name?.trim()) return { error: "name is required.", status: 400 };

  let normalizedTags;
  try {
    normalizedTags = normalizeTags(tags);
  } catch (err) {
    return { error: err.message, status: 400 };
  }

  const { storageResources } = await getOrgCollections();
  const orgObjectId = toObjectId(orgId);
  const now = new Date().toISOString();

  // Every resource's real bytes live in a real, already-tested S3-compat
  // bucket -- this is the one and only place data is actually stored.
  const backingBucket = `${type}-${name.trim()}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 63);
  await ensureS3Bucket({ orgId, bucket: backingBucket, actorEmail });

  const doc = {
    orgId: orgObjectId, type, name: name.trim(),
    region: region?.trim() || "default", // logical label, not physical geography -- see module header
    status: "AVAILABLE",
    tags: normalizedTags,
    encryptionState: "inherited-client-side", // always-on via the shared custody pipeline; not a per-resource toggle
    capacity: Number.isFinite(Number(capacity)) ? { requestedGB: Number(capacity), enforced: false } : null,
    performanceProfile: performanceProfile ? { ...performanceProfile, enforced: false } : null,
    physicalCapability: PHYSICAL_CAPABILITY[type],
    backingBucket,
    attachmentState: type === "volume" ? "AVAILABLE" : null,
    attachedTo: null,
    mountTargets: type === "fileShare" ? [] : null,
    createdByEmail: actorEmail, createdAt: now, updatedAt: now, deletedAt: null,
  };
  const result = await storageResources.insertOne(doc);

  await logOrgActivity({ orgId, recordType: "STORAGE_RESOURCE", recordId: result.insertedId, actorEmail, action: "CREATED", previousState: null, newState: "AVAILABLE", metadata: { type, name: doc.name, region: doc.region } });
  return { resource: { ...doc, _id: result.insertedId } };
}

export async function listStorageResources({ orgId, type, tagSelector, membership }) {
  const denied = await assertAccess(membership, false);
  if (denied) return denied;
  const { storageResources } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId), deletedAt: null };
  if (type) query.type = type;
  let resources = await storageResources.find(query).sort({ createdAt: -1 }).toArray();
  if (tagSelector) resources = resources.filter((r) => matchesSelector(r.tags, tagSelector));
  return { resources };
}

export async function getStorageResource({ orgId, resourceId, membership }) {
  const denied = await assertAccess(membership, false);
  if (denied) return denied;
  const { storageResources } = await getOrgCollections();
  const resource = await storageResources.findOne({ _id: toObjectId(resourceId), orgId: toObjectId(orgId), deletedAt: null });
  if (!resource) return { error: "Resource not found.", status: 404 };
  return { resource };
}

/** Capacity increases only -- decrease is rejected per the SOW's own
 *  instruction ("Capacity decrease must be rejected unless a real backend
 *  supports safe shrink") -- no such backend exists here. */
export async function expandStorageResourceCapacity({ orgId, resourceId, newCapacityGB, membership, actorEmail }) {
  const denied = await assertAccess(membership, true);
  if (denied) return denied;
  const { storageResources } = await getOrgCollections();
  const resource = await storageResources.findOne({ _id: toObjectId(resourceId), orgId: toObjectId(orgId), deletedAt: null });
  if (!resource) return { error: "Resource not found.", status: 404 };
  const current = resource.capacity?.requestedGB ?? 0;
  const next = Number(newCapacityGB);
  if (!Number.isFinite(next) || next <= current) return { error: `newCapacityGB must be a number greater than the current capacity (${current} GB). Capacity decrease is not supported.`, status: 400 };

  await storageResources.updateOne({ _id: resource._id }, { $set: { capacity: { requestedGB: next, enforced: false }, updatedAt: new Date().toISOString() } });
  await logOrgActivity({ orgId, recordType: "STORAGE_RESOURCE", recordId: resource._id, actorEmail, action: "CAPACITY_EXPANDED", previousState: current, newState: next, metadata: {} });
  return { requestedGB: next };
}

export async function deleteStorageResource({ orgId, resourceId, membership, actorEmail }) {
  const denied = await assertAccess(membership, true);
  if (denied) return denied;
  const { storageResources } = await getOrgCollections();
  const resource = await storageResources.findOne({ _id: toObjectId(resourceId), orgId: toObjectId(orgId), deletedAt: null });
  if (!resource) return { error: "Resource not found.", status: 404 };
  if (resource.attachmentState === "ATTACHED") return { error: "Detach this resource before deleting it.", status: 409 };

  await storageResources.updateOne({ _id: resource._id }, { $set: { deletedAt: new Date().toISOString(), status: "DELETED" } });
  await logOrgActivity({ orgId, recordType: "STORAGE_RESOURCE", recordId: resource._id, actorEmail, action: "DELETED", previousState: resource.status, newState: "DELETED", metadata: {} });
  return { deleted: true };
}

// ---------------------------------------------------------------------
// Volume attach/detach (Workstream B) -- a real reservation/lock, not a
// physical block-device mount. See module header.
// ---------------------------------------------------------------------

export async function attachVolume({ orgId, resourceId, attachedTo, membership, actorEmail }) {
  const denied = await assertAccess(membership, false);
  if (denied) return denied;
  if (!attachedTo?.trim()) return { error: "attachedTo (a label identifying the declared consumer) is required.", status: 400 };

  const { storageResources } = await getOrgCollections();
  const resource = await storageResources.findOne({ _id: toObjectId(resourceId), orgId: toObjectId(orgId), deletedAt: null, type: "volume" });
  if (!resource) return { error: "Volume not found.", status: 404 };
  if (resource.attachmentState === "ATTACHED") {
    return { error: `Already attached to "${resource.attachedTo}". Detach before reattaching elsewhere.`, status: 409 };
  }

  const now = new Date().toISOString();
  await storageResources.updateOne({ _id: resource._id }, { $set: { attachmentState: "ATTACHED", attachedTo: attachedTo.trim(), updatedAt: now } });
  await logOrgActivity({ orgId, recordType: "STORAGE_RESOURCE", recordId: resource._id, actorEmail, action: "VOLUME_ATTACHED", previousState: "AVAILABLE", newState: "ATTACHED", metadata: { attachedTo: attachedTo.trim() } });
  return { attachmentState: "ATTACHED", attachedTo: attachedTo.trim() };
}

export async function detachVolume({ orgId, resourceId, membership, actorEmail }) {
  const denied = await assertAccess(membership, false);
  if (denied) return denied;
  const { storageResources } = await getOrgCollections();
  const resource = await storageResources.findOne({ _id: toObjectId(resourceId), orgId: toObjectId(orgId), deletedAt: null, type: "volume" });
  if (!resource) return { error: "Volume not found.", status: 404 };
  if (resource.attachmentState !== "ATTACHED") return { error: "This volume is not currently attached.", status: 409 };

  const now = new Date().toISOString();
  await storageResources.updateOne({ _id: resource._id }, { $set: { attachmentState: "AVAILABLE", attachedTo: null, updatedAt: now } });
  await logOrgActivity({ orgId, recordType: "STORAGE_RESOURCE", recordId: resource._id, actorEmail, action: "VOLUME_DETACHED", previousState: "ATTACHED", newState: "AVAILABLE", metadata: {} });
  return { attachmentState: "AVAILABLE" };
}

// ---------------------------------------------------------------------
// File share mount targets (Workstreams C/D) -- declared/bookkeeping
// records only. Nothing here provisions a real NFS endpoint.
// ---------------------------------------------------------------------

export async function addMountTarget({ orgId, resourceId, label, protocol, authorizedClients, membership, actorEmail }) {
  const denied = await assertAccess(membership, true);
  if (denied) return denied;
  if (!label?.trim()) return { error: "label is required.", status: 400 };

  const { storageResources } = await getOrgCollections();
  const resource = await storageResources.findOne({ _id: toObjectId(resourceId), orgId: toObjectId(orgId), deletedAt: null, type: "fileShare" });
  if (!resource) return { error: "File share not found.", status: 404 };

  const mountTarget = {
    id: new ObjectId(),
    label: label.trim(),
    protocol: protocol || "declared-nfs", // never a real, connectable NFS endpoint -- see module header
    authorizedClients: authorizedClients || [],
    physicallyMountable: false,
    createdAt: new Date().toISOString(),
  };
  await storageResources.updateOne({ _id: resource._id }, { $push: { mountTargets: mountTarget }, $set: { updatedAt: mountTarget.createdAt } });
  await logOrgActivity({ orgId, recordType: "STORAGE_RESOURCE", recordId: resource._id, actorEmail, action: "MOUNT_TARGET_ADDED", previousState: null, newState: null, metadata: { label: mountTarget.label } });
  return { mountTarget };
}

export async function removeMountTarget({ orgId, resourceId, mountTargetId, membership, actorEmail }) {
  const denied = await assertAccess(membership, true);
  if (denied) return denied;
  const { storageResources } = await getOrgCollections();
  const resource = await storageResources.findOne({ _id: toObjectId(resourceId), orgId: toObjectId(orgId), deletedAt: null, type: "fileShare" });
  if (!resource) return { error: "File share not found.", status: 404 };

  await storageResources.updateOne({ _id: resource._id }, { $pull: { mountTargets: { id: new ObjectId(mountTargetId) } }, $set: { updatedAt: new Date().toISOString() } });
  await logOrgActivity({ orgId, recordType: "STORAGE_RESOURCE", recordId: resource._id, actorEmail, action: "MOUNT_TARGET_REMOVED", previousState: null, newState: null, metadata: { mountTargetId } });
  return { removed: true };
}
