// src/lib/nas/updates.js
//
// Sovereign NAS SOW Workstream Z (update and lifecycle management).
//
// What is REAL: the appliance-side agent is versioned, hash-pinned software
// and can be updated safely:
//   pre-update health check -> configuration backup -> install (previous copy
//   kept) -> post-update verification -> automatic rollback if verification
//   fails; an update never starts while a backup, replication or recovery
//   drill is running.
// What is NOT done (SOW 33: "do not implement automatic firmware flashing
// unless the platform supports a safe documented mechanism"): OS packages,
// kernel and firmware are not touched, and release metadata is hash-pinned
// (sha256 of the bundled agent) rather than cryptographically signed --
// reported as such.

import { getOrgCollections, toObjectId } from "../orgs.js";
import { fail, gate, loadAppliance, iso } from "./common.js";
import { getBundledAgentInfo } from "./agent.js";
import { recordNasEvidence } from "./evidence.js";

export const UPDATE_CHANNELS = ["stable", "beta"];
const BLOCKING_KINDS = ["backup", "replicate", "drill", "recovery"];

export async function checkForUpdate({ orgId, applianceId, membership }) {
  const denied = gate(membership, false);
  if (denied) return denied;
  const res = await loadAppliance({ orgId, applianceId });
  if (res.error) return res;
  const [installed, bundled] = await Promise.all([res.agent.installedAgent(), getBundledAgentInfo()]);
  return {
    channel: res.appliance.updateChannel || "stable",
    current: installed ? { version: installed.agentVersion, sha256: installed.agentSha256, kernel: installed.kernel, python: installed.python } : null,
    available: bundled,
    updateAvailable: !!installed && installed.agentSha256 !== bundled.sha256,
    releaseMetadata: { integrity: "sha256-pinned", signed: false, note: "Release integrity is a pinned SHA-256 of the bundled agent; it is not cryptographically signed." },
    scope: "Agent software only. OS packages, kernel and firmware are not modified by this product.",
  };
}

export async function setUpdateChannel({ orgId, applianceId, channel, membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  if (!UPDATE_CHANNELS.includes(channel)) return fail("channel must be stable or beta.");
  const res = await loadAppliance({ orgId, applianceId });
  if (res.error) return res;
  const { nasAppliances } = await getOrgCollections();
  await nasAppliances.updateOne({ _id: res.appliance._id }, { $set: { updateChannel: channel } });
  await recordNasEvidence({ orgId, applianceId, subjectType: "NAS_APPLIANCE", subjectId: applianceId, action: "POLICY_CHANGED", actorEmail, data: { change: "update-channel", channel }, graph: false });
  return { channel };
}

export async function applyUpdate({ orgId, applianceId, membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  const res = await loadAppliance({ orgId, applianceId });
  if (res.error) return res;
  const { appliance, agent } = res;
  const { nasJobs, nasUpdates } = await getOrgCollections();

  // ---- pre-update checks
  const active = await nasJobs.countDocuments({ orgId: toObjectId(orgId), applianceId: appliance._id, status: "RUNNING", kind: { $in: BLOCKING_KINDS } });
  const installed = await agent.installedAgent();
  const bundled = await getBundledAgentInfo();
  const preflight = { activeCriticalJobs: active, agentReachable: !!installed, servicesUp: null };
  if (installed) preflight.servicesUp = await agent.call("services", {}).catch(() => null);
  const row = { orgId: toObjectId(orgId), applianceId: appliance._id, fromVersion: installed?.agentVersion || null, fromSha256: installed?.agentSha256 || null, toVersion: bundled.version, toSha256: bundled.sha256, state: "PREFLIGHT", preflight, startedBy: actorEmail, createdAt: iso() };
  const ins = await nasUpdates.insertOne(row);
  const finish = async (state, extra = {}) => { await nasUpdates.updateOne({ _id: ins.insertedId }, { $set: { state, finishedAt: iso(), ...extra } }); return { updateId: ins.insertedId, state, ...extra }; };

  if (active > 0) return { ...(await finish("BLOCKED", { reason: "A backup, replication or recovery job is running; updates never start during critical operations." })), error: "A critical operation is running; try again when it finishes.", status: 409 };
  if (!installed) return { ...(await finish("BLOCKED", { reason: "The appliance agent is not reachable." })), error: "The appliance agent is not reachable.", status: 502 };
  if (installed.agentSha256 === bundled.sha256) return finish("UP_TO_DATE", { note: "The appliance already runs this version." });
  if (preflight.servicesUp && !preflight.servicesUp.smbd) return { ...(await finish("BLOCKED", { reason: "File sharing is not healthy; fix that before updating." })), error: "File sharing is not healthy.", status: 409 };

  // ---- configuration backup, install, verify, rollback on failure
  let cfg;
  try { cfg = await agent.call("config_backup", {}); } catch (e) { return { ...(await finish("BLOCKED", { reason: `Configuration backup failed: ${e.message}` })), error: "Configuration backup failed; update not started.", status: 502 }; }
  await nasUpdates.updateOne({ _id: ins.insertedId }, { $set: { state: "APPLYING", configBackup: cfg } });
  try {
    await agent.installAgent({ keepPrevious: true });
    const v = await agent.rawCall("version", {});
    const ok = v.agentSha256 === bundled.sha256;
    const online = await agent.call("ensure_online", {}).catch(() => null);
    const smbUp = !!online?.services?.smbd;
    if (!ok || !smbUp) throw new Error(!ok ? "Post-update verification failed (agent hash mismatch)." : "Post-update check failed: file sharing is not running.");
    await recordNasEvidence({ orgId, applianceId, subjectType: "NAS_APPLIANCE", subjectId: applianceId, action: "UPDATE_APPLIED", actorEmail, integrityHash: bundled.sha256, data: { from: installed.agentVersion, to: bundled.version, configBackup: cfg.backup }, graph: false });
    return await finish("COMPLETED", { postCheck: { agentHashMatches: true, smbUp: true } });
  } catch (err) {
    let rolledBack = false;
    try { await agent.rollbackAgent(); rolledBack = true; } catch { /* reported below */ }
    await recordNasEvidence({ orgId, applianceId, subjectType: "NAS_APPLIANCE", subjectId: applianceId, action: "UPDATE_ROLLED_BACK", actorEmail, result: rolledBack ? "ROLLED_BACK" : "ROLLBACK_FAILED", data: { reason: String(err.message).slice(0, 200) }, graph: false });
    return { ...(await finish(rolledBack ? "ROLLED_BACK" : "ROLLBACK_FAILED", { reason: String(err.message).slice(0, 300) })), error: `Update failed and was ${rolledBack ? "rolled back" : "NOT rolled back"}: ${err.message}`, status: 502 };
  }
}

export async function listUpdates({ orgId, applianceId, membership }) {
  const denied = gate(membership, false);
  if (denied) return denied;
  const { nasUpdates } = await getOrgCollections();
  const q = { orgId: toObjectId(orgId) };
  if (applianceId) q.applianceId = toObjectId(applianceId);
  return { updates: await nasUpdates.find(q).sort({ createdAt: -1 }).limit(50).toArray() };
}
