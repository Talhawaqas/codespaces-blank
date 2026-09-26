// src/lib/nas/health.js
//
// Sovereign NAS SOW Workstreams Q, D and T (health, observability and the
// plain-language overview).
//
// Every figure is labelled MEASURED (read from the appliance), DERIVED
// (computed from measured values), ESTIMATED or UNKNOWN. Nothing is invented:
// a virtual disk has no SMART temperature, a VM has no fan or UPS sensor, so
// those come back UNKNOWN with the reason.
//
// The stored appliance state (nasApplianceState) is the read model used by the
// Digital Twin and by cards, so a What-If scenario never has to call the
// appliance (and can never mutate it).

import { getOrgCollections, toObjectId } from "../orgs.js";
import { fail, gate, loadAppliance, iso } from "./common.js";
import { summarizeJobs } from "./jobs.js";
import { verifyNasEvidence } from "./evidence.js";
import { recoveryReadiness } from "./backup.js";
import { replicationHealth } from "./replication.js";
import { NasAgentClient } from "./agent.js";

const CONTROL_PLANE_HOST = process.env.NAS_CONTROL_PLANE_PROBE_HOST || "www.inayanetwork.com";

/** Measures the appliance and stores the result as its current state. */
export async function checkApplianceState({ orgId, applianceId, membership }) {
  const denied = gate(membership, false);
  if (denied) return denied;
  const res = await loadAppliance({ orgId, applianceId });
  if (res.error) return res;
  const { appliance, agent } = res;
  const t0 = Date.now();
  const [metrics, disks, services, net, probe] = await Promise.all([
    agent.call("metrics", {}).catch((e) => ({ error: e.message })),
    agent.call("disks", {}).catch((e) => ({ error: e.message })),
    agent.call("services", {}).catch(() => ({ smbd: false, nfs: false })),
    agent.call("network_info", {}).catch(() => null),
    agent.call("net_probe", { host: CONTROL_PLANE_HOST, port: 443 }).catch(() => ({ reachable: false, measurement: "UNKNOWN" })),
  ]);
  const { nasPools, nasShares } = await getOrgCollections();
  const poolRows = await nasPools.find({ orgId: toObjectId(orgId), applianceId: appliance._id, deletedAt: null }).toArray();
  const pools = [];
  for (const p of poolRows) pools.push(await agent.call("pool_status", { pool: p.name }).catch((e) => ({ pool: p.name, health: "UNKNOWN", error: e.message })));
  const shareRows = await nasShares.find({ orgId: toObjectId(orgId), applianceId: appliance._id, deletedAt: null }).toArray();
  const state = {
    orgId: toObjectId(orgId), applianceId: appliance._id, checkedAt: iso(), measuredInMs: Date.now() - t0,
    services, metrics, disks: disks.disks || [], pools, network: net,
    controlPlane: { host: CONTROL_PLANE_HOST, ...probe, meaning: "Whether the APPLIANCE can reach the Inaya cloud. Local file access does not depend on it." },
    shares: shareRows.map((s) => ({ id: String(s._id), name: s.shareName, backend: s.backend || "dir", quota: s.quota ? { hardBytes: s.quota.hardBytes, enforced: s.quota.enforced, state: s.quota.state } : null, worm: !!s.worm?.enabled, lockdown: !!s.access?.lockdown?.active, lastBackupAt: s.lastBackup?.at || null, lastBackupManifest: s.lastBackup?.manifestHash || null })),
    bootRecovery: NasAgentClient.lastBootRecovery || null,
  };
  const { nasApplianceState, nasAppliances } = await getOrgCollections();
  await nasApplianceState.updateOne({ orgId: state.orgId, applianceId: appliance._id }, { $set: state }, { upsert: true });
  const smbUp = !!services.smbd;
  const status = smbUp ? (pools.some((p) => p.degraded) ? "DEGRADED" : "REACHABLE") : "UNREACHABLE";
  await nasAppliances.updateOne({ _id: appliance._id }, { $set: { status, lastHealthCheckAt: state.checkedAt } });
  return { state, status };
}

export async function getStoredState({ orgId, applianceId }) {
  const { nasApplianceState } = await getOrgCollections();
  return nasApplianceState.findOne({ orgId: toObjectId(orgId), applianceId: toObjectId(applianceId) });
}

function card(status, headline, details = [], extra = {}) {
  return { status, headline, details, ...extra };
}

/** The main-screen answers (SOW 43), in plain language. */
export async function getOverview({ orgId, applianceId, membership }) {
  const denied = gate(membership, false);
  if (denied) return denied;
  const res = await loadAppliance({ orgId, applianceId });
  if (res.error) return res;
  const { appliance } = res;
  const stored = await getStoredState({ orgId, applianceId });
  const { nasShares, nasThreatEvents, nasReplicationPolicies, nasBackupRuns } = await getOrgCollections();
  const shares = await nasShares.find({ orgId: toObjectId(orgId), applianceId: appliance._id, deletedAt: null }).toArray();

  // Storage / disk
  const pools = stored?.pools || [];
  const degraded = pools.filter((p) => p.degraded || p.health === "DEGRADED");
  const storage = !stored ? card("UNKNOWN", "Not measured yet", ["Run a health check."]) :
    degraded.length ? card("CRITICAL", `${degraded.length} storage pool(s) running degraded`, ["A mirror member has failed. Data is still readable but has no redundancy until it is rebuilt.", "RAID is not backup."], { measurement: "MEASURED" }) :
    !stored.services?.smbd ? card("CRITICAL", "File sharing (SMB) is not running", [], { measurement: "MEASURED" }) :
    card("OK", pools.length ? `${pools.length} pool(s) healthy` : "File sharing is running", [`SMB ${stored.services.smbd ? "up" : "down"}, NFS ${stored.services.nfs ? "up" : "down"}`], { measurement: "MEASURED" });
  const virtualDisks = (stored?.disks || []).some((d) => d.virtual);
  const disk = !stored ? card("UNKNOWN", "Not measured yet") : card("UNKNOWN", virtualDisks ? "Virtual disks: physical health cannot be measured" : `${stored.disks.length} disk(s) seen`, virtualDisks ? ["This appliance runs on virtual disks. SMART, temperature and UPS data do not exist here, so they are shown as UNKNOWN rather than invented."] : [], { measurement: "MEASURED" });

  // Backup + recovery per share
  let backupBad = 0; let backupNever = 0; const recovery = [];
  for (const s of shares) {
    const last = await nasBackupRuns.find({ orgId: toObjectId(orgId), shareId: s._id }).sort({ startedAt: -1 }).limit(1).next();
    if (!last) backupNever++; else if (!["COMPLETED"].includes(last.status)) backupBad++;
    recovery.push({ shareId: String(s._id), share: s.shareName, ...(await recoveryReadiness({ orgId, shareId: s._id })) });
  }
  const backup = !shares.length ? card("UNKNOWN", "No shares yet") : backupBad ? card("CRITICAL", `${backupBad} share(s) with a failed or partial backup`) : backupNever ? card("ATTENTION", `${backupNever} share(s) never backed up`) : card("OK", "Every share has a completed, verified backup", [], { measurement: "MEASURED" });
  const notReady = recovery.filter((r) => r.state !== "READY");
  const recoveryCard = !shares.length ? card("UNKNOWN", "No shares yet") : notReady.length ? card(notReady.some((r) => r.state === "NO_BACKUP") ? "CRITICAL" : "ATTENTION", `${notReady.length} of ${recovery.length} share(s) not proven recoverable`, ["A completed backup is not recovery-ready until a test restore has matched the bytes."], { basis: "DERIVED", perShare: recovery }) : card("OK", "Test restores match the latest backups", [], { basis: "DERIVED", perShare: recovery });

  // Replication
  const reps = await nasReplicationPolicies.find({ orgId: toObjectId(orgId), applianceId: appliance._id }).toArray();
  const repHealth = reps.map((r) => replicationHealth(r));
  const replication = !reps.length ? card("UNKNOWN", "No replication configured") : repHealth.some((h) => h === "FAILED") ? card("CRITICAL", "A replication policy is failing") : repHealth.some((h) => h === "DEGRADED") ? card("ATTENTION", "A replica is out of date") : card("OK", "Replicas are current");

  // Security
  const threats = await nasThreatEvents.find({ orgId: toObjectId(orgId), state: "OPEN", shareId: { $in: shares.map((s) => s._id) } }).toArray();
  const locked = shares.filter((s) => s.access?.lockdown?.active);
  const security = threats.length ? card(threats.some((t) => ["HIGH", "CRITICAL"].includes(t.level)) ? "CRITICAL" : "ATTENTION", `${threats.length} open threat event(s)`, locked.length ? [`${locked.length} share(s) are locked down (read-only).`] : []) : card("OK", "No open threats");

  // Evidence integrity
  const ev = await verifyNasEvidence({ orgId, applianceId: appliance._id, limit: 200 }).catch((e) => ({ verified: false, error: e.message }));
  const evidence = card(ev.verified ? "OK" : "CRITICAL", ev.verified ? `${ev.rowsChecked} evidence records verified against the audit chain` : "Evidence verification found a problem", ev.problems?.slice(0, 3).map((p) => `${p.action}: ${p.problem}`) || []);

  const jobs = await summarizeJobs({ orgId, applianceId });
  const cp = stored?.controlPlane;
  return {
    appliance: { id: String(appliance._id), name: appliance.name, status: appliance.status },
    cards: {
      storageHealth: storage, diskHealth: disk, backupHealth: backup, replicationHealth: replication, securityHealth: security, recoveryReadiness: recoveryCard, evidenceIntegrity: evidence,
      digitalTwin: card("OK", "What-If simulations are available", ["Simulate a disk failure, the NAS going offline, ransomware, an employee losing access, or the NAS reaching 95% full -- without touching the live NAS."]),
    },
    controlPlane: cp ? { reachableFromAppliance: cp.reachable, note: cp.reachable ? null : "The appliance cannot reach the Inaya cloud. Local file access continues; cloud-dependent jobs queue and show a degraded state." } : null,
    jobs, checkedAt: stored?.checkedAt || null,
  };
}
