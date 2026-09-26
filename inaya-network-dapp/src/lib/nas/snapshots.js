// src/lib/nas/snapshots.js
//
// Sovereign NAS SOW Workstreams E (local snapshots) and F (WORM/immutable
// storage).
//
// What each snapshot really is is reported, never implied (SOW 12):
//   - Btrfs share  -> "copy-on-write" (near-instant, shares blocks with the
//                     live data);
//   - directory    -> "full-copy" (an independent byte copy).
// "Immutable" is used ONLY when deletion and modification are technically
// prevented for the retention period: an immutable snapshot's files carry the
// filesystem immutable flag (chattr +i) and, on Btrfs, the subvolume is set
// read-only, so `rm -rf` and `btrfs subvolume delete` are refused (tested).
// The lock is governance-grade: root on the appliance can still lift it, which
// is stated wherever the lock is shown. "compliance" mode simply offers no
// API override path.

import { getOrgCollections, toObjectId, canManageOrg } from "../orgs.js";
import { fail, gate, loadShare, daysFromNow, SYNTHETIC_OWNER, notifyNasManagers } from "./common.js";
import { recordNasEvidence } from "./evidence.js";
import { registerJobHandler, enqueueJob } from "./jobs.js";

export const LOCK_MODES = ["governance", "compliance"];
const LOCK_NOTE = "Governance-grade lock: it stops users, ransomware and compromised share credentials. Root on the appliance itself can still remove the flag.";

function snapName(prefix = "snap") {
  const t = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `${prefix}-${t}-${Math.random().toString(36).slice(2, 5)}`;
}

function publicSnapshot(s) {
  return { ...s, semantics: { copyOnWrite: s.type === "copy-on-write", fullCopy: s.type === "full-copy", immutable: !!s.immutable && s.state === "AVAILABLE" && (!s.retentionUntil || new Date(s.retentionUntil) > new Date()), note: s.immutable ? LOCK_NOTE : null } };
}

export async function createSnapshotCore({ orgId, share, agent, name, immutable = false, retentionDays, lockMode = "governance", source = "manual", reason, actorEmail, actorType = "human" }) {
  const snapshot = name || snapName(source === "threat" ? "threat" : "snap");
  let retentionUntil = null;
  if (immutable) {
    const d = Number(retentionDays);
    if (!Number.isFinite(d) || d < 0.0001 || d > 3650) return fail("An immutable snapshot needs retentionDays between a few seconds and 3650 days.");
    retentionUntil = daysFromNow(d);
  }
  let made;
  try {
    made = await agent.call("snapshot_create", { share: share.shareName, snapshot, immutable, retentionUntil: retentionUntil ? Math.floor(retentionUntil.getTime() / 1000) : null }, { timeout: 900000 });
  } catch (err) {
    return fail(`The appliance could not create the snapshot: ${err.message}`, err.code === "EXISTS" ? 409 : 502);
  }
  const { nasSnapshots } = await getOrgCollections();
  const doc = {
    orgId: toObjectId(orgId), applianceId: share.applianceId, shareId: share._id, name: snapshot, type: made.type, immutable, lockMode: immutable ? lockMode : null,
    retentionUntil: retentionUntil ? retentionUntil.toISOString() : null, manifestHash: made.manifestHash, fileCount: made.fileCount, totalBytes: made.totalBytes,
    createLatencyMs: made.createLatencyMs, source, reason: reason || null, state: "AVAILABLE", createdBy: actorEmail, actorType, createdAt: new Date().toISOString(),
  };
  const r = await nasSnapshots.insertOne(doc);
  await recordNasEvidence({ orgId, applianceId: share.applianceId, subjectId: share._id, action: "SNAPSHOT_CREATED", actorEmail, actorType, integrityHash: made.manifestHash, data: { snapshot, type: made.type, fileCount: made.fileCount, totalBytes: made.totalBytes, source } });
  if (immutable) await recordNasEvidence({ orgId, applianceId: share.applianceId, subjectId: share._id, action: "SNAPSHOT_LOCKED", actorEmail, actorType, integrityHash: made.manifestHash, policy: { lockMode, retentionUntil: doc.retentionUntil }, data: { snapshot } });
  return { snapshot: publicSnapshot({ ...doc, _id: r.insertedId }) };
}

export async function createSnapshot({ orgId, shareId, name, immutable = false, retentionDays, lockMode = "governance", reason, membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  if (name != null && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(name)) return fail("Snapshot name: letters, digits, '.', '-', '_' (max 64).");
  if (!LOCK_MODES.includes(lockMode)) return fail("lockMode must be governance or compliance.");
  const res = await loadShare({ orgId, shareId });
  if (res.error) return res;
  return createSnapshotCore({ orgId, share: res.share, agent: res.agent, name, immutable, retentionDays, lockMode, source: "manual", reason, actorEmail });
}

/** Snapshots, reconciled with what is really on the appliance. */
export async function listSnapshots({ orgId, shareId, membership }) {
  const denied = gate(membership, false);
  if (denied) return denied;
  const res = await loadShare({ orgId, shareId });
  if (res.error) return res;
  const { nasSnapshots } = await getOrgCollections();
  const rows = await nasSnapshots.find({ orgId: toObjectId(orgId), shareId: res.share._id, state: { $ne: "DELETED" } }).sort({ createdAt: -1 }).toArray();
  let live = [];
  try { live = (await res.agent.call("snapshot_list", { share: res.share.shareName })).snapshots; } catch { /* leave empty: reported below */ }
  const liveByName = new Map(live.map((l) => [l.name, l]));
  return { snapshots: rows.map((r) => publicSnapshot({ ...r, presentOnAppliance: liveByName.has(r.name), lockedOnAppliance: !!liveByName.get(r.name)?.locked })) };
}

async function loadSnapshot({ orgId, snapshotId }) {
  const { nasSnapshots } = await getOrgCollections();
  let snap;
  try { snap = await nasSnapshots.findOne({ _id: toObjectId(snapshotId), orgId: toObjectId(orgId) }); } catch { snap = null; }
  if (!snap) return fail("Snapshot not found.", 404);
  const res = await loadShare({ orgId, shareId: snap.shareId });
  if (res.error) return res;
  return { snap, ...res };
}

/** Recomputes the snapshot's file manifest and compares it to the recorded one. */
export async function verifySnapshot({ orgId, snapshotId, membership }) {
  const denied = gate(membership, false);
  if (denied) return denied;
  const r = await loadSnapshot({ orgId, snapshotId });
  if (r.error) return r;
  try {
    const m = await r.agent.call("manifest", { share: r.share.shareName, snapshot: r.snap.name }, { timeout: 300000 });
    return { verified: m.manifestHash === r.snap.manifestHash, recordedManifestHash: r.snap.manifestHash, actualManifestHash: m.manifestHash, fileCount: m.fileCount };
  } catch (err) {
    return { verified: false, error: err.message };
  }
}

export async function browseSnapshot({ orgId, snapshotId, relPath, membership }) {
  const denied = gate(membership, false);
  if (denied) return denied;
  const r = await loadSnapshot({ orgId, snapshotId });
  if (r.error) return r;
  try {
    return await r.agent.call("snapshot_browse", { share: r.share.shareName, snapshot: r.snap.name, relPath: relPath || undefined });
  } catch (err) {
    return fail(err.message, err.code === "TRAVERSAL" ? 400 : 502);
  }
}

/** File-level or share-level recovery. The default restores into
 *  `.restored/<snapshot>/` so live data is never silently overwritten; an
 *  in-place restore needs an explicit reason and is evidenced. */
export async function restoreSnapshot({ orgId, snapshotId, relPath, inPlace = false, reason, membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  if (inPlace && String(reason || "").trim().length < 5) return fail("An in-place restore overwrites live data and needs a reason (at least 5 characters).");
  const r = await loadSnapshot({ orgId, snapshotId });
  if (r.error) return r;
  try {
    const out = await r.agent.call("snapshot_restore", { share: r.share.shareName, snapshot: r.snap.name, relPath: relPath || undefined, inPlace }, { timeout: 900000 });
    await recordNasEvidence({ orgId, applianceId: r.share.applianceId, subjectId: r.share._id, action: "FILE_RESTORED", actorEmail, integrityHash: r.snap.manifestHash, data: { snapshot: r.snap.name, relPath: relPath || null, inPlace, restoredTo: out.restoredTo, reason: reason || null } });
    return { restored: out };
  } catch (err) {
    return fail(err.message, err.code === "TRAVERSAL" ? 400 : err.code === "NOT_FOUND" ? 404 : 502);
  }
}

/** Deleting a locked snapshot is refused and the attempt itself is recorded
 *  (a snapshot-deletion attempt is a ransomware signal, SOW 19). Governance
 *  mode allows an owner/admin override with a reason; compliance mode has no
 *  API override at all. */
export async function deleteSnapshot({ orgId, snapshotId, override = false, reason, membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  const r = await loadSnapshot({ orgId, snapshotId });
  if (r.error) return r;
  const { snap, share, agent } = r;
  const locked = snap.immutable && snap.retentionUntil && new Date(snap.retentionUntil) > new Date();
  if (locked) {
    const allowedOverride = override && snap.lockMode === "governance" && canManageOrg(membership) && String(reason || "").trim().length >= 10;
    if (!allowedOverride) {
      await recordNasEvidence({ orgId, applianceId: share.applianceId, subjectId: share._id, action: "SNAPSHOT_DELETE_DENIED", actorEmail, result: "DENIED", data: { snapshot: snap.name, retentionUntil: snap.retentionUntil, overrideRequested: !!override, lockMode: snap.lockMode } });
      const why = snap.lockMode === "compliance" ? "compliance mode has no override" : override ? "an override needs an organization owner/admin and a reason of at least 10 characters" : "pass override with a reason (governance mode, owner/admin only)";
      return fail(`This snapshot is locked until ${snap.retentionUntil}; ${why}.`, 403);
    }
  }
  try {
    await agent.call("snapshot_delete", { share: share.shareName, snapshot: snap.name, override: !!locked }, { timeout: 300000 });
  } catch (err) {
    if (err.code === "LOCKED") return fail(err.message, 403);
    return fail(`The appliance could not delete the snapshot: ${err.message}`, 502);
  }
  const { nasSnapshots } = await getOrgCollections();
  await nasSnapshots.updateOne({ _id: snap._id }, { $set: { state: "DELETED", deletedAt: new Date().toISOString(), deletedBy: actorEmail } });
  await recordNasEvidence({ orgId, applianceId: share.applianceId, subjectId: share._id, action: "SNAPSHOT_DELETED", actorEmail, integrityHash: snap.manifestHash, data: { snapshot: snap.name, overrideUsed: !!locked, reason: reason || null } });
  return { deleted: true, overrideUsed: !!locked };
}

/** Lifts expired locks (snapshots and WORM files) and records it. */
export async function releaseExpiredLocks({ orgId } = {}) {
  const { nasSnapshots, nasAppliances } = await getOrgCollections();
  const now = new Date().toISOString();
  const q = { immutable: true, state: "AVAILABLE", retentionUntil: { $lte: now } };
  if (orgId) q.orgId = toObjectId(orgId);
  const expired = await nasSnapshots.find(q).toArray();
  const released = [];
  const appliances = new Map();
  for (const s of expired) {
    const key = String(s.applianceId);
    if (!appliances.has(key)) {
      const { NasAgentClient } = await import("./agent.js");
      const a = await nasAppliances.findOne({ _id: s.applianceId, deletedAt: null });
      appliances.set(key, a ? { appliance: a, agent: new NasAgentClient({ backend: a.backend }) } : null);
    }
    const ctx = appliances.get(key);
    if (!ctx) continue;
    try {
      await ctx.agent.call("snapshot_release_expired", {});
      await nasSnapshots.updateOne({ _id: s._id }, { $set: { state: "AVAILABLE", immutable: false, lockReleasedAt: now } });
      await recordNasEvidence({ orgId: s.orgId, applianceId: s.applianceId, subjectId: s.shareId, action: "SNAPSHOT_RELEASED", actorEmail: "system", actorType: "system", integrityHash: s.manifestHash, data: { snapshot: s.name } });
      released.push(s.name);
    } catch (err) {
      console.error("releaseExpiredLocks:", err.message);
    }
  }
  for (const ctx of appliances.values()) if (ctx) await ctx.agent.call("worm_release_expired", {}).catch(() => {});
  return { released };
}

// ---------------------------------------------------------------- policies
export async function setSnapshotPolicy({ orgId, shareId, intervalMinutes, keepLast = 7, immutable = false, retentionDays, enabled = true, membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  const im = Number(intervalMinutes);
  if (!Number.isFinite(im) || im < 1 || im > 525600) return fail("intervalMinutes must be 1-525600.");
  if (!Number.isInteger(keepLast) || keepLast < 1 || keepLast > 1000) return fail("keepLast must be 1-1000.");
  if (immutable && !(Number(retentionDays) > 0)) return fail("An immutable policy needs retentionDays.");
  const res = await loadShare({ orgId, shareId });
  if (res.error) return res;
  const { nasSnapshotPolicies } = await getOrgCollections();
  const now = new Date().toISOString();
  const doc = { orgId: toObjectId(orgId), shareId: res.share._id, applianceId: res.share.applianceId, intervalMinutes: im, keepLast, immutable: !!immutable, retentionDays: immutable ? Number(retentionDays) : null, enabled: !!enabled, nextRunAt: now, updatedAt: now, updatedBy: actorEmail };
  await nasSnapshotPolicies.updateOne({ orgId: doc.orgId, shareId: doc.shareId }, { $set: doc, $setOnInsert: { createdAt: now } }, { upsert: true });
  await recordNasEvidence({ orgId, applianceId: res.share.applianceId, subjectId: res.share._id, action: "POLICY_CHANGED", actorEmail, policy: { kind: "snapshot", intervalMinutes: im, keepLast, immutable, retentionDays: doc.retentionDays, enabled }, data: { change: "snapshot-policy" }, graph: false });
  return { policy: doc };
}

export async function getSnapshotPolicy({ orgId, shareId, membership }) {
  const denied = gate(membership, false);
  if (denied) return denied;
  const { nasSnapshotPolicies } = await getOrgCollections();
  return { policy: await nasSnapshotPolicies.findOne({ orgId: toObjectId(orgId), shareId: toObjectId(shareId) }) };
}

/** Runs one policy: take the scheduled snapshot, then prune. Never prunes a locked snapshot. */
export async function runSnapshotPolicy({ orgId, shareId }) {
  const { nasSnapshotPolicies, nasSnapshots } = await getOrgCollections();
  const policy = await nasSnapshotPolicies.findOne({ orgId: toObjectId(orgId), shareId: toObjectId(shareId) });
  if (!policy || !policy.enabled) return { skipped: true };
  const res = await loadShare({ orgId, shareId });
  if (res.error) return res;
  const made = await createSnapshotCore({ orgId, share: res.share, agent: res.agent, immutable: policy.immutable, retentionDays: policy.retentionDays, source: "scheduled", actorEmail: "system", actorType: "system" });
  if (made.error) return made;
  const all = await nasSnapshots.find({ orgId: toObjectId(orgId), shareId: res.share._id, source: "scheduled", state: "AVAILABLE" }).sort({ createdAt: -1 }).toArray();
  const pruned = [];
  for (const old of all.slice(policy.keepLast)) {
    const locked = old.immutable && old.retentionUntil && new Date(old.retentionUntil) > new Date();
    if (locked) continue;
    try {
      await res.agent.call("snapshot_delete", { share: res.share.shareName, snapshot: old.name }, { timeout: 300000 });
      await nasSnapshots.updateOne({ _id: old._id }, { $set: { state: "DELETED", deletedAt: new Date().toISOString(), deletedBy: "retention-policy" } });
      pruned.push(old.name);
    } catch (err) {
      console.error("snapshot prune failed:", err.message);
    }
  }
  await nasSnapshotPolicies.updateOne({ _id: policy._id }, { $set: { lastRunAt: new Date().toISOString(), nextRunAt: new Date(Date.now() + policy.intervalMinutes * 60000).toISOString() } });
  return { snapshot: made.snapshot.name, pruned };
}

registerJobHandler("snapshot_policy", async (job) => {
  const out = await runSnapshotPolicy({ orgId: job.orgId, shareId: job.shareId });
  if (out.error) throw new Error(out.error);
  return { result: out };
});

// -------------------------------------------------------------------- WORM
/** First-class immutable-storage policy for a share (SOW 13). */
export async function setWormPolicy({ orgId, shareId, enabled = true, retentionDays = 30, settleMinutes = 1, mode = "governance", override = false, reason, membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  if (!LOCK_MODES.includes(mode)) return fail("mode must be governance or compliance.");
  const res = await loadShare({ orgId, shareId });
  if (res.error) return res;
  const { share, agent } = res;
  const { nasShares } = await getOrgCollections();
  if (enabled) {
    if (!(Number(retentionDays) > 0)) return fail("retentionDays must be greater than 0.");
    let sealed;
    try {
      sealed = await agent.call("worm_enable", { share: share.shareName, retentionDays: Number(retentionDays), settleMinutes: Number(settleMinutes) }, { timeout: 300000 });
    } catch (err) {
      return fail(`WORM could not be enabled on the appliance: ${err.message}`, 502);
    }
    const worm = { enabled: true, mode, retentionDays: Number(retentionDays), settleMinutes: Number(settleMinutes), owner: actorEmail, lockStart: share.worm?.lockStart || new Date().toISOString(), lockExpiry: new Date(sealed.retentionUntil * 1000).toISOString() };
    await nasShares.updateOne({ _id: share._id }, { $set: { worm, updatedAt: new Date().toISOString() } });
    await recordNasEvidence({ orgId, applianceId: share.applianceId, subjectId: share._id, action: "POLICY_CHANGED", actorEmail, policy: { kind: "worm", mode, retentionDays: worm.retentionDays, settleMinutes: worm.settleMinutes }, data: { change: "worm-enabled", sealedNow: sealed.sealedNow, note: LOCK_NOTE } });
    return { worm, sealed, note: LOCK_NOTE };
  }
  // disabling: refused while retained unless governance override
  const status = await agent.call("worm_status", { share: share.shareName }).catch(() => null);
  const retained = status?.enabled && status.earliestExpiry && status.earliestExpiry * 1000 > Date.now();
  if (retained && (share.worm?.mode === "compliance" || !override || !canManageOrg(membership) || String(reason || "").trim().length < 10)) {
    await recordNasEvidence({ orgId, applianceId: share.applianceId, subjectId: share._id, action: "SNAPSHOT_DELETE_DENIED", actorEmail, result: "DENIED", data: { attempted: "worm-disable", mode: share.worm?.mode } });
    return fail(share.worm?.mode === "compliance" ? "Compliance-mode WORM cannot be disabled before retention ends." : "Files are still under retention: disabling needs override with a reason (owner/admin only).", 403);
  }
  try {
    await agent.call("worm_disable", { share: share.shareName, override: !!retained }, { timeout: 300000 });
  } catch (err) {
    return fail(err.message, err.code === "LOCKED" ? 403 : 502);
  }
  await nasShares.updateOne({ _id: share._id }, { $set: { worm: { enabled: false }, updatedAt: new Date().toISOString() } });
  await recordNasEvidence({ orgId, applianceId: share.applianceId, subjectId: share._id, action: "POLICY_CHANGED", actorEmail, data: { change: "worm-disabled", overrideUsed: !!retained, reason: reason || null } });
  return { worm: { enabled: false } };
}

export async function sealWorm({ orgId, shareId }) {
  const res = await loadShare({ orgId, shareId });
  if (res.error) return res;
  if (!res.share.worm?.enabled) return { skipped: true };
  const r = await res.agent.call("worm_seal", { share: res.share.shareName }, { timeout: 300000 });
  if (r.sealedNow) await recordNasEvidence({ orgId, applianceId: res.share.applianceId, subjectId: res.share._id, action: "SNAPSHOT_LOCKED", actorType: "system", actorEmail: "system", data: { scope: "worm-files", sealedNow: r.sealedNow, sealedTotal: r.sealedTotal }, graph: false });
  return r;
}

export async function getWormStatus({ orgId, shareId, membership }) {
  const denied = gate(membership, false);
  if (denied) return denied;
  const res = await loadShare({ orgId, shareId });
  if (res.error) return res;
  return { policy: res.share.worm || { enabled: false }, appliance: await res.agent.call("worm_status", { share: res.share.shareName }), note: LOCK_NOTE };
}

registerJobHandler("worm_seal", async (job) => ({ result: await sealWorm({ orgId: job.orgId, shareId: job.shareId }) }));
registerJobHandler("release_locks", async (job) => ({ result: await releaseExpiredLocks({ orgId: job.orgId }) }));

/** Queue the due scheduled snapshot / seal jobs (idempotent per time bucket). */
export async function enqueueDueSnapshotWork({ orgId } = {}) {
  const { nasSnapshotPolicies, nasShares } = await getOrgCollections();
  const now = new Date();
  const q = { enabled: true, nextRunAt: { $lte: now.toISOString() } };
  if (orgId) q.orgId = toObjectId(orgId);
  let queued = 0;
  for (const p of await nasSnapshotPolicies.find(q).toArray()) {
    const bucket = Math.floor(now.getTime() / (p.intervalMinutes * 60000));
    const r = await enqueueJob({ orgId: p.orgId, applianceId: p.applianceId, shareId: p.shareId, kind: "snapshot_policy", idempotencyKey: `snapshot:${p.shareId}:${bucket}` });
    if (r.created) queued++;
  }
  const wq = { deletedAt: null, "worm.enabled": true };
  if (orgId) wq.orgId = toObjectId(orgId);
  for (const s of await nasShares.find(wq).toArray()) {
    const bucket = Math.floor(now.getTime() / 60000);
    const r = await enqueueJob({ orgId: s.orgId, applianceId: s.applianceId, shareId: s._id, kind: "worm_seal", idempotencyKey: `worm:${s._id}:${bucket}` });
    if (r.created) queued++;
  }
  return { queued };
}
