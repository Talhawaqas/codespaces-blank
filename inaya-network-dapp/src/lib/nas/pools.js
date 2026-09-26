// src/lib/nas/pools.js
//
// Sovereign NAS SOW Workstream D (storage pool / disk management).
//
// On the documented VM appliance profile (SOW 36A.1 "VM-based development
// target") a pool is REAL Linux storage, not a database row:
//   - level "raid1": an mdadm mirror over two virtual disks (image files
//     attached as loop devices), with a Btrfs filesystem on top;
//   - level "single": one virtual disk with Btrfs (no redundancy, and
//     reported as such).
// Btrfs supplies checksums (scrub detects and, on a mirror, repairs
// corruption), copy-on-write snapshots and subvolume quotas. No proprietary
// RAID is invented (SOW 11.1).
//
// "RAID is not backup" (SOW 11.2): every pool status carries that reminder,
// and a mirrored pool with one failed member is reported DEGRADED, not fine.
//
// Physical SMART, temperature and UPS data do not exist on a virtual disk;
// they are returned as UNKNOWN with the reason (SOW 24), never invented.

import { getOrgCollections, toObjectId } from "../orgs.js";
import { fail, gate, loadAppliance } from "./common.js";
import { recordNasEvidence } from "./evidence.js";

const NOT_BACKUP = "RAID / redundancy is not backup: a mirror protects against a disk failing, not against deletion, ransomware or a site loss.";

export async function createPool({ orgId, applianceId, name, level = "single", memberSizeMb = 512, allowFailureInjection = false, membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/.test(name || "")) return fail("Pool name: letters, digits, hyphen, underscore (max 32).");
  if (!["single", "raid1"].includes(level)) return fail("level must be single or raid1.");
  const res = await loadAppliance({ orgId, applianceId });
  if (res.error) return res;
  const { nasPools } = await getOrgCollections();
  if (await nasPools.findOne({ orgId: toObjectId(orgId), applianceId: res.appliance._id, name, deletedAt: null })) return fail("A pool with that name already exists.", 409);
  let status;
  try {
    status = await res.agent.call("pool_create", { pool: name, level, memberSizeMb: Number(memberSizeMb) }, { timeout: 300000 });
  } catch (err) {
    return fail(`Pool creation failed on the appliance: ${err.message}`, 502);
  }
  const doc = { orgId: toObjectId(orgId), applianceId: res.appliance._id, name, level, memberSizeMb: Number(memberSizeMb), allowFailureInjection: !!allowFailureInjection, createdBy: actorEmail, createdAt: new Date().toISOString(), deletedAt: null };
  const r = await nasPools.insertOne(doc);
  await recordNasEvidence({ orgId, applianceId: res.appliance._id, subjectType: "NAS_APPLIANCE", subjectId: res.appliance._id, action: "POOL_CREATED", actorEmail, newState: status.health, data: { pool: name, level, filesystem: "btrfs" }, graph: false });
  return { pool: { ...doc, _id: r.insertedId }, status: { ...status, reminder: NOT_BACKUP } };
}

export async function listPools({ orgId, applianceId, membership }) {
  const denied = gate(membership, false);
  if (denied) return denied;
  const { nasPools } = await getOrgCollections();
  const q = { orgId: toObjectId(orgId), deletedAt: null };
  if (applianceId) q.applianceId = toObjectId(applianceId);
  const pools = await nasPools.find(q).toArray();
  const out = [];
  for (const p of pools) {
    const res = await loadAppliance({ orgId, applianceId: p.applianceId });
    let status = null;
    if (!res.error) status = await res.agent.call("pool_status", { pool: p.name }).catch((e) => ({ health: "UNKNOWN", error: e.message }));
    out.push({ ...p, status: status ? { ...status, reminder: NOT_BACKUP } : null });
  }
  return { pools: out };
}

async function loadPool({ orgId, poolId }) {
  const { nasPools } = await getOrgCollections();
  let pool;
  try { pool = await nasPools.findOne({ _id: toObjectId(poolId), orgId: toObjectId(orgId), deletedAt: null }); } catch { pool = null; }
  if (!pool) return fail("Pool not found.", 404);
  const res = await loadAppliance({ orgId, applianceId: pool.applianceId });
  if (res.error) return res;
  return { pool, ...res };
}

export async function getPoolStatus({ orgId, poolId, membership }) {
  const denied = gate(membership, false);
  if (denied) return denied;
  const r = await loadPool({ orgId, poolId });
  if (r.error) return r;
  const status = await r.agent.call("pool_status", { pool: r.pool.name });
  return { pool: r.pool, status: { ...status, reminder: NOT_BACKUP } };
}

/** btrfs scrub: reads every block and verifies checksums (measured errors). */
export async function scrubPool({ orgId, poolId, membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  const r = await loadPool({ orgId, poolId });
  if (r.error) return r;
  const result = await r.agent.call("pool_scrub", { pool: r.pool.name }, { timeout: 900000 });
  return { scrub: result };
}

/** Controlled failure injection: only on a pool created with
 *  allowFailureInjection, only a mirrored pool, and only with the
 *  confirmation phrase. Real mdadm --fail/--remove. */
export async function simulateDiskFailure({ orgId, poolId, member = 1, confirm, membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  const r = await loadPool({ orgId, poolId });
  if (r.error) return r;
  if (!r.pool.allowFailureInjection) return fail("This pool was not created for failure testing.", 403);
  if (r.pool.level !== "raid1") return fail("Only a mirrored pool can lose a member without losing data.", 400);
  if (confirm !== "FAIL-DISK") return fail('Type confirm: "FAIL-DISK" to inject a real member failure.', 400);
  const status = await r.agent.call("pool_fail_disk", { pool: r.pool.name, member: Number(member) }, { timeout: 60000 });
  await recordNasEvidence({ orgId, applianceId: r.pool.applianceId, subjectType: "NAS_APPLIANCE", subjectId: r.pool.applianceId, action: "POOL_DEGRADED", actorEmail, newState: status.health, data: { pool: r.pool.name, member: Number(member), injected: true }, graph: false });
  return { status: { ...status, reminder: NOT_BACKUP } };
}

export async function replaceDisk({ orgId, poolId, member = 1, membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  const r = await loadPool({ orgId, poolId });
  if (r.error) return r;
  if (r.pool.level !== "raid1") return fail("Only a mirrored pool can rebuild a member.", 400);
  const status = await r.agent.call("pool_replace_disk", { pool: r.pool.name, member: Number(member), wait: true }, { timeout: 900000 });
  await recordNasEvidence({ orgId, applianceId: r.pool.applianceId, subjectType: "NAS_APPLIANCE", subjectId: r.pool.applianceId, action: "POOL_REBUILT", actorEmail, newState: status.health, data: { pool: r.pool.name, member: Number(member) }, graph: false });
  return { status: { ...status, reminder: NOT_BACKUP } };
}

export async function deletePool({ orgId, poolId, membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  const r = await loadPool({ orgId, poolId });
  if (r.error) return r;
  const { nasShares, nasPools } = await getOrgCollections();
  if (await nasShares.findOne({ orgId: toObjectId(orgId), poolId: r.pool._id, deletedAt: null })) return fail("The pool still holds shares.", 409);
  await r.agent.call("pool_destroy", { pool: r.pool.name }, { timeout: 120000 });
  await nasPools.updateOne({ _id: r.pool._id }, { $set: { deletedAt: new Date().toISOString() } });
  return { deleted: true };
}

/** Disks with their SMART/temperature state, honestly labelled. */
export async function listDisks({ orgId, applianceId, membership }) {
  const denied = gate(membership, false);
  if (denied) return denied;
  const res = await loadAppliance({ orgId, applianceId });
  if (res.error) return res;
  return res.agent.call("disks", {});
}
