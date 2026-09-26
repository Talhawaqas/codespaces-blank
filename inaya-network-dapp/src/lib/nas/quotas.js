// src/lib/nas/quotas.js
//
// Sovereign NAS SOW Workstream I (quotas and capacity governance).
//
// The SOW is explicit: "Do not claim quota enforcement if the application
// merely displays a number without preventing writes." So a quota here is
// only marked `enforced: true` when the appliance backend really blocks
// writes:
//   - Btrfs shares: a qgroup referenced limit (writes fail with EDQUOT);
//   - ext4 quota volumes: a fixed-size filesystem (writes fail with ENOSPC)
//     plus per-user block quotas (setquota) -- the only backend here that
//     supports USER quotas;
//   - legacy directory shares: no filesystem quota exists, so the quota is
//     reported as NOT enforced with the reason, never as a hard limit.

import { getOrgCollections, toObjectId } from "../orgs.js";
import { fail, gate, loadShare, loadAppliance, notifyNasManagers } from "./common.js";
import { recordNasEvidence } from "./evidence.js";

export const QUOTA_STATES = ["NORMAL", "WARNING", "NEAR_LIMIT", "HARD_LIMIT", "FULL"];
const ORDER = Object.fromEntries(QUOTA_STATES.map((s, i) => [s, i]));

/** Pure. NORMAL < WARNING < NEAR_LIMIT < HARD_LIMIT < FULL. */
export function quotaState({ usedBytes, hardBytes, softBytes, warnPercent = 80, criticalPercent = 95, freeBytes = null }) {
  if (freeBytes !== null && freeBytes < 1024 * 1024) return "FULL";
  if (!hardBytes) return softBytes && usedBytes >= softBytes ? "WARNING" : "NORMAL";
  const pct = (usedBytes / hardBytes) * 100;
  if (pct >= 100) return "HARD_LIMIT";
  if (pct >= criticalPercent) return "NEAR_LIMIT";
  if (pct >= warnPercent || (softBytes && usedBytes >= softBytes)) return "WARNING";
  return "NORMAL";
}

export function isWorse(next, prev) {
  return (ORDER[next] ?? 0) > (ORDER[prev] ?? 0);
}

export async function setShareQuota({ orgId, shareId, hardBytes, softBytes = null, warnPercent = 80, criticalPercent = 95, membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  const res = await loadShare({ orgId, shareId });
  if (res.error) return res;
  const { share, agent } = res;
  if (hardBytes != null && (!Number.isFinite(Number(hardBytes)) || Number(hardBytes) < 1024 * 1024)) return fail("hardBytes must be at least 1 MB (or null to remove the limit).");
  if (softBytes != null && hardBytes != null && Number(softBytes) > Number(hardBytes)) return fail("The soft quota cannot exceed the hard quota.");
  if (!(warnPercent > 0 && warnPercent < criticalPercent && criticalPercent <= 100)) return fail("warnPercent must be below criticalPercent (both 1-100).");
  let mech;
  try {
    mech = await agent.call("share_quota_set", { share: share.shareName, hardBytes: hardBytes == null ? null : Number(hardBytes) });
  } catch (err) {
    return fail(`The appliance did not apply the quota: ${err.message}`, 502);
  }
  const quota = {
    hardBytes: hardBytes == null ? null : Number(hardBytes), softBytes: softBytes == null ? null : Number(softBytes), warnPercent, criticalPercent,
    enforced: !!mech.enforced, mechanism: mech.mechanism || null, notEnforcedReason: mech.enforced ? null : mech.reason || "This share's backend cannot enforce quotas.",
    state: "NORMAL", updatedAt: new Date().toISOString(),
  };
  const { nasShares } = await getOrgCollections();
  await nasShares.updateOne({ _id: share._id }, { $set: { quota, updatedAt: quota.updatedAt } });
  await recordNasEvidence({ orgId, applianceId: share.applianceId, subjectId: share._id, action: "QUOTA_CHANGED", actorEmail, newState: quota.enforced ? "ENFORCED" : "NOT_ENFORCED", data: { hardBytes: quota.hardBytes, softBytes: quota.softBytes, mechanism: quota.mechanism } });
  return { quota };
}

/** Real usage + state. Notifies managers (once per state) when it worsens. */
export async function getShareCapacity({ orgId, shareId, membership, notify = true }) {
  const denied = gate(membership, false);
  if (denied) return denied;
  const res = await loadShare({ orgId, shareId });
  if (res.error) return res;
  const { share, agent } = res;
  let usage;
  try {
    usage = await agent.call("share_usage", { share: share.shareName }, { timeout: 60000 });
  } catch (err) {
    return fail(`Usage could not be measured: ${err.message}`, 502);
  }
  let free = null;
  try { free = (await agent.call("disk_usage", { share: share.shareName })).availBytes; } catch { /* leave null */ }
  const q = share.quota || {};
  const hard = q.hardBytes || (usage.limitBytes && usage.enforced ? usage.limitBytes : null);
  const state = quotaState({ usedBytes: usage.usedBytes ?? 0, hardBytes: hard, softBytes: q.softBytes, warnPercent: q.warnPercent, criticalPercent: q.criticalPercent, freeBytes: free });
  if (notify && isWorse(state, q.state || "NORMAL")) {
    await notifyNasManagers({ orgId, type: "nas_quota_state", severity: state === "WARNING" ? "warning" : "critical", title: `Share ${share.shareName} is ${state.replace("_", " ").toLowerCase()}`, body: `Using ${usage.usedBytes} of ${hard || "unlimited"} bytes.`, dedupeKey: `${shareId}:quota:${state}`, sourceId: share._id });
    await recordNasEvidence({ orgId, applianceId: share.applianceId, subjectId: share._id, action: "QUOTA_STATE_CHANGED", actorType: "system", previousState: q.state || "NORMAL", newState: state, data: { usedBytes: usage.usedBytes, hardBytes: hard }, graph: false });
  }
  if (state !== (q.state || "NORMAL")) {
    const { nasShares } = await getOrgCollections();
    await nasShares.updateOne({ _id: share._id }, { $set: { "quota.state": state, "quota.lastCheckedAt": new Date().toISOString(), "quota.lastUsedBytes": usage.usedBytes } });
  }
  return { usedBytes: usage.usedBytes, hardBytes: hard, softBytes: q.softBytes || null, freeBytes: free, state, enforced: !!(q.enforced || usage.enforced), backend: usage.backend, measurement: usage.measurement };
}

export async function setUserQuota({ orgId, shareId, nasUserId, softBytes = 0, hardBytes, membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  const res = await loadShare({ orgId, shareId });
  if (res.error) return res;
  const { nasUsers } = await getOrgCollections();
  const acct = await nasUsers.findOne({ _id: toObjectId(nasUserId), orgId: toObjectId(orgId), applianceId: res.share.applianceId, revokedAt: null });
  if (!acct) return fail("NAS account not found on this appliance.", 404);
  let r;
  try {
    r = await res.agent.call("user_quota_set", { share: res.share.shareName, username: acct.unixUsername, softBytes: Number(softBytes) || 0, hardBytes: Number(hardBytes) });
  } catch (err) {
    return fail(`The appliance did not apply the user quota: ${err.message}`, 502);
  }
  if (!r.supported) return { supported: false, enforced: false, reason: r.reason };
  await recordNasEvidence({ orgId, applianceId: res.share.applianceId, subjectId: res.share._id, action: "QUOTA_CHANGED", actorEmail, data: { scope: "user", unixUsername: acct.unixUsername, hardBytes: r.hardBytes } });
  return { supported: true, enforced: true, ...r };
}

export async function getUserQuotas({ orgId, shareId, membership }) {
  const denied = gate(membership, false);
  if (denied) return denied;
  const res = await loadShare({ orgId, shareId });
  if (res.error) return res;
  return res.agent.call("user_quota_usage", { share: res.share.shareName });
}

/** NAS total + pool capacity (MEASURED). */
export async function getApplianceCapacity({ orgId, applianceId, membership }) {
  const denied = gate(membership, false);
  if (denied) return denied;
  const res = await loadAppliance({ orgId, applianceId });
  if (res.error) return res;
  const total = await res.agent.call("disk_usage", {});
  const { nasPools } = await getOrgCollections();
  const pools = await nasPools.find({ orgId: toObjectId(orgId), applianceId: res.appliance._id, deletedAt: null }).toArray();
  const poolStatus = [];
  for (const p of pools) poolStatus.push(await res.agent.call("pool_status", { pool: p.name }).catch((e) => ({ pool: p.name, error: e.message })));
  return { nasRoot: total, pools: poolStatus };
}
