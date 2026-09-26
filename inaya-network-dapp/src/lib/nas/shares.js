// src/lib/nas/shares.js
//
// Sovereign NAS SOW Workstreams B, C, I, K. Real share management: every
// call drives the appliance agent, which writes a Samba stanza / NFS export
// and creates the backing directory or Btrfs subvolume -- never a database
// row pretending a share exists.
//
// Backends (share.backend):
//   dir        legacy: a directory on the appliance root filesystem
//   btrfs      a Btrfs subvolume in a pool (snapshots, qgroup quotas, RAID1)
//   ext4quota  a fixed-size ext4 volume with user/group quotas
//
// Quotas are enforced only where the backend can (see quotas.js); the first
// pass's `enforced:false` for everything is corrected here now that real
// enforcing backends exist.

import { getOrgCollections, toObjectId } from "../orgs.js";
import { logOrgActivity } from "../org-activity-log.js";
import { fail, gate, loadShare, loadAppliance } from "./common.js";
import { recordNasEvidence } from "./evidence.js";
import { applyShareAccess } from "./access.js";
import { setShareQuota } from "./quotas.js";

const SHARE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const BACKENDS = ["dir", "btrfs", "ext4quota"];

export async function createShare({ orgId, applianceId, shareName, ownerUnixUser, quotaBytes, backend = "dir", poolId, departmentId, volumeSizeMb, recycleRetentionDays = 30, membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  if (!SHARE_NAME_RE.test(shareName || "")) return fail("shareName must be 1-64 chars: letters, digits, hyphen, underscore only.");
  if (!ownerUnixUser?.trim()) return fail("ownerUnixUser is required (must already exist as a NAS user -- see users.js).");
  if (!BACKENDS.includes(backend)) return fail(`backend must be one of ${BACKENDS.join(", ")}.`);

  const res = await loadAppliance({ orgId, applianceId });
  if (res.error) return res;
  const { appliance, agent } = res;

  const { nasShares, nasPools } = await getOrgCollections();
  if (await nasShares.findOne({ orgId: toObjectId(orgId), applianceId: appliance._id, shareName, deletedAt: null })) return fail(`Share "${shareName}" already exists on this appliance.`, 409);

  let pool = null;
  if (backend === "btrfs") {
    pool = poolId ? await nasPools.findOne({ _id: toObjectId(poolId), orgId: toObjectId(orgId), applianceId: appliance._id, deletedAt: null }) : null;
    if (!pool) return fail("A btrfs share needs a pool on this appliance (poolId).");
  }

  let provisioned;
  try {
    if (backend === "ext4quota") await agent.call("volume_create", { name: shareName, sizeMb: Number(volumeSizeMb) || 256 }, { timeout: 300000 });
    provisioned = await agent.createShare({ shareName, ownerUnixUser: ownerUnixUser.trim(), recycleBin: true, backend, pool: pool?.name || null });
  } catch (err) {
    return fail(`Real share provisioning failed: ${err.message}`, 502);
  }

  const now = new Date().toISOString();
  const doc = {
    orgId: toObjectId(orgId), applianceId: appliance._id, shareName, ownerUnixUser: ownerUnixUser.trim(), dataPath: provisioned.dataPath,
    backend, poolId: pool?._id || null, poolName: pool?.name || null, departmentId: departmentId ? toObjectId(departmentId) : null,
    quota: null, protocol: "smb", protocols: { smb: true, nfs: { enabled: false } },
    access: { entries: [], hostsAllow: [], readOnly: false, hidden: false, enabled: true, lockdown: { active: false } },
    recycle: { enabled: true, retentionDays: recycleRetentionDays }, recycleBinEnabled: true, worm: { enabled: false },
    status: "ACTIVE", createdByEmail: actorEmail, createdAt: now, updatedAt: now, deletedAt: null,
  };
  const result = await nasShares.insertOne(doc);
  const share = { ...doc, _id: result.insertedId };
  await logOrgActivity({ orgId, recordType: "NAS_SHARE", recordId: result.insertedId, actorEmail, action: "SHARE_CREATED", previousState: null, newState: "ACTIVE", metadata: { shareName, applianceId: String(applianceId), backend } });
  await recordNasEvidence({ orgId, applianceId: appliance._id, subjectId: result.insertedId, action: "SHARE_CREATED", actorEmail, newState: "ACTIVE", data: { shareName, backend, pool: pool?.name || null } });

  if (quotaBytes != null && Number.isFinite(Number(quotaBytes))) {
    const q = await setShareQuota({ orgId, shareId: result.insertedId, hardBytes: Number(quotaBytes), membership, actorEmail });
    if (q.quota) share.quota = q.quota;
  }
  return { share };
}

export async function listShares({ orgId, applianceId, membership }) {
  const denied = gate(membership, false);
  if (denied) return denied;
  const { nasShares } = await getOrgCollections();
  const query = { orgId: toObjectId(orgId), deletedAt: null };
  if (applianceId) query.applianceId = toObjectId(applianceId);
  return { shares: await nasShares.find(query).sort({ createdAt: -1 }).toArray() };
}

export async function getShare({ orgId, shareId, membership }) {
  const denied = gate(membership, false);
  if (denied) return denied;
  const res = await loadShare({ orgId, shareId });
  if (res.error) return res;
  return { share: res.share };
}

/** Renames the SMB share name; the data path and its contents do not move. */
export async function renameShare({ orgId, shareId, newName, membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  if (!SHARE_NAME_RE.test(newName || "")) return fail("newName must be 1-64 chars: letters, digits, hyphen, underscore only.");
  const res = await loadShare({ orgId, shareId });
  if (res.error) return res;
  const { share, agent } = res;
  const { nasShares } = await getOrgCollections();
  if (await nasShares.findOne({ orgId: toObjectId(orgId), applianceId: share.applianceId, shareName: newName, deletedAt: null })) return fail("A share with that name already exists.", 409);
  try {
    await agent.call("share_rename", { name: share.shareName, newName });
  } catch (err) {
    return fail(`Rename failed on the appliance: ${err.message}`, 502);
  }
  await nasShares.updateOne({ _id: share._id }, { $set: { shareName: newName, updatedAt: new Date().toISOString() } });
  await recordNasEvidence({ orgId, applianceId: share.applianceId, subjectId: share._id, action: "POLICY_CHANGED", actorEmail, previousState: share.shareName, newState: newName, data: { change: "rename" } });
  return { renamed: true, shareName: newName };
}

/** Enable/disable (Samba `available`), hidden, read-only -- through the
 *  same access policy pipeline so nothing bypasses fail-closed validation. */
export async function updateShareSettings({ orgId, shareId, enabled, hidden, readOnly, membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  const res = await loadShare({ orgId, shareId });
  if (res.error) return res;
  const { share, agent } = res;
  const access = { ...(share.access || {}), ...(enabled != null ? { enabled: !!enabled } : {}), ...(hidden != null ? { hidden: !!hidden } : {}), ...(readOnly != null ? { readOnly: !!readOnly } : {}) };
  try {
    await applyShareAccess({ orgId, share: { ...share, access }, agent });
  } catch (err) {
    return fail(`The appliance rejected the change (nothing changed): ${err.message}`, 502);
  }
  const { nasShares } = await getOrgCollections();
  await nasShares.updateOne({ _id: share._id }, { $set: { access, updatedAt: new Date().toISOString() } });
  await recordNasEvidence({ orgId, applianceId: share.applianceId, subjectId: share._id, action: "POLICY_CHANGED", actorEmail, data: { enabled: access.enabled, hidden: access.hidden, readOnly: access.readOnly } });
  return { access };
}

export async function deleteShare({ orgId, shareId, purgeData = false, membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  const res = await loadShare({ orgId, shareId });
  if (res.error) return res;
  const { share, agent } = res;
  try {
    await agent.deleteShare({ shareName: share.shareName, purgeData });
    if (agent && share.protocols?.nfs?.enabled) await agent.call("nfs_remove", { name: share.shareName }).catch(() => {});
  } catch (err) {
    return fail(`Real share removal failed: ${err.message}`, 502);
  }
  const { nasShares } = await getOrgCollections();
  await nasShares.updateOne({ _id: share._id }, { $set: { deletedAt: new Date().toISOString(), status: "DELETED" } });
  await logOrgActivity({ orgId, recordType: "NAS_SHARE", recordId: share._id, actorEmail, action: "SHARE_DELETED", previousState: "ACTIVE", newState: "DELETED", metadata: { shareName: share.shareName, purgeData } });
  return { deleted: true };
}

// ------------------------------------------------------------------- NFS
/** NFSv4 export management: client restrictions (never a wildcard), ro/rw,
 *  root squash. Only CIDRs/hosts are accepted; `*` and /0 are rejected by
 *  the appliance agent. */
export async function setNfsExport({ orgId, shareId, enabled = true, clients = [], readOnly = false, rootSquash = true, membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  const res = await loadShare({ orgId, shareId });
  if (res.error) return res;
  const { share, agent } = res;
  let out = null;
  try {
    if (enabled) out = await agent.call("nfs_apply", { name: share.shareName, clients, readOnly, rootSquash });
    else await agent.call("nfs_remove", { name: share.shareName });
  } catch (err) {
    return fail(`NFS export not changed: ${err.message}`, err.code === "PUBLIC_EXPOSURE" || err.code === "BAD_INPUT" ? 400 : 502);
  }
  const nfs = enabled ? { enabled: true, clients: out.clients, readOnly: out.mode === "ro", rootSquash: out.rootSquash } : { enabled: false };
  const { nasShares } = await getOrgCollections();
  await nasShares.updateOne({ _id: share._id }, { $set: { "protocols.nfs": nfs, updatedAt: new Date().toISOString() } });
  await recordNasEvidence({ orgId, applianceId: share.applianceId, subjectId: share._id, action: "POLICY_CHANGED", actorEmail, data: { change: "nfs-export", ...nfs } });
  return { nfs };
}

// ----------------------------------------------------------- recycle bin
export async function listRecycleBin({ orgId, shareId, membership }) {
  const denied = gate(membership, false);
  if (denied) return denied;
  const res = await loadShare({ orgId, shareId });
  if (res.error) return res;
  const { entries } = await res.agent.call("recycle_list", { share: res.share.shareName });
  return { entries: entries.map(({ path, ...rest }) => rest) };
}

export async function restoreFromRecycleBin({ orgId, shareId, recyclePath, overwrite = false, membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  const res = await loadShare({ orgId, shareId });
  if (res.error) return res;
  try {
    const r = await res.agent.call("recycle_restore", { share: res.share.shareName, recyclePath, overwrite });
    await recordNasEvidence({ orgId, applianceId: res.share.applianceId, subjectId: res.share._id, action: "FILE_RESTORED", actorEmail, data: { source: "recycle-bin", restoredTo: r.restoredTo } });
    return r;
  } catch (err) {
    return fail(err.message, err.code === "EXISTS" ? 409 : err.code === "NOT_FOUND" ? 404 : err.code === "TRAVERSAL" ? 400 : 502);
  }
}

export async function purgeRecycleBin({ orgId, shareId, recyclePath, olderThanDays, membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  const res = await loadShare({ orgId, shareId });
  if (res.error) return res;
  const days = olderThanDays ?? res.share.recycle?.retentionDays ?? 30;
  try {
    const r = await res.agent.call("recycle_purge", recyclePath ? { share: res.share.shareName, recyclePath } : { share: res.share.shareName, olderThanDays: days });
    await recordNasEvidence({ orgId, applianceId: res.share.applianceId, subjectId: res.share._id, action: "FILE_DELETED", actorEmail, data: { source: "recycle-bin-purge", removed: r.removed, scope: recyclePath ? "entry" : `older-than-${days}d` }, graph: false });
    return r;
  } catch (err) {
    return fail(err.message, err.code === "TRAVERSAL" ? 400 : 502);
  }
}

export async function setRecycleRetention({ orgId, shareId, retentionDays, membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  const d = Number(retentionDays);
  if (!Number.isFinite(d) || d < 1 || d > 3650) return fail("retentionDays must be 1-3650.");
  const res = await loadShare({ orgId, shareId });
  if (res.error) return res;
  const { nasShares } = await getOrgCollections();
  await nasShares.updateOne({ _id: res.share._id }, { $set: { "recycle.retentionDays": d, updatedAt: new Date().toISOString() } });
  await recordNasEvidence({ orgId, applianceId: res.share.applianceId, subjectId: res.share._id, action: "POLICY_CHANGED", actorEmail, data: { change: "recycle-retention", retentionDays: d }, graph: false });
  return { retentionDays: d };
}
