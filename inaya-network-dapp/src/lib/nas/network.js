// src/lib/nas/network.js
//
// Sovereign NAS SOW Workstreams R (network discovery), S (secure remote
// access) and J (file locking).
//
// Remote access (SOW 26): raw SMB/NFS is NEVER exposed to the Internet. The
// modes are enforced on the appliance (Samba `hosts allow` / `hosts deny`),
// not just labelled in the UI, and any network that is not private/loopback/
// link-local is rejected by the agent:
//   LOCAL_ONLY       loopback (plus explicitly listed private networks)
//   PRIVATE_NETWORK  RFC1918 private ranges (or a narrower allow-list)
//   GATEWAY          data-plane clients limited to the appliance itself;
//                    remote users come through the authenticated Inaya
//                    gateway / VPN, browser or Drive -- "remote access
//                    enabled" means that path is on, not that SMB is public.
// Every change is audited.
//
// Discovery (SOW 25): the appliance hostname is configurable and reported
// (IPv4 and IPv6, MEASURED); mDNS/DNS-SD advertisement (avahi) is real and is
// verified by resolving the name INSIDE the appliance. Honest limit: this VM
// sits behind WSL2's NAT, so `<name>.local` is not resolvable from other
// machines on the office LAN -- a bridged VM or physical appliance would be.
//
// Locking (SOW 17): Samba provides real SMB locking/oplocks; listLocks reads
// them and explainLock turns them into a plain-language answer.

import { fail, gate, loadAppliance, loadShare } from "./common.js";
import { getOrgCollections } from "../orgs.js";
import { recordNasEvidence } from "./evidence.js";

export const REMOTE_MODES = ["LOCAL_ONLY", "PRIVATE_NETWORK", "GATEWAY"];
export const REMOTE_LABEL = { LOCAL_ONLY: "LOCAL ONLY", PRIVATE_NETWORK: "PRIVATE NETWORK", GATEWAY: "REMOTE ACCESS VIA INAYA GATEWAY" };

export async function getRemoteAccess({ orgId, applianceId, membership }) {
  const denied = gate(membership, false);
  if (denied) return denied;
  const res = await loadAppliance({ orgId, applianceId });
  if (res.error) return res;
  return { remoteAccess: res.appliance.remoteAccess || { mode: "UNCONFIGURED", label: "Not configured (Samba default rules apply)" }, warning: "Raw SMB/NFS is never exposed to the public Internet by this product." };
}

export async function setRemoteAccess({ orgId, applianceId, mode, allowedNetworks = [], membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  if (!REMOTE_MODES.includes(mode)) return fail(`mode must be one of ${REMOTE_MODES.join(", ")}.`);
  const res = await loadAppliance({ orgId, applianceId });
  if (res.error) return res;
  const before = res.appliance.remoteAccess?.mode || "UNCONFIGURED";
  let applied;
  try {
    applied = await res.agent.call("remote_access_apply", { mode, allowedNetworks });
  } catch (err) {
    return fail(err.message, ["PUBLIC_EXPOSURE", "BAD_INPUT"].includes(err.code) ? 400 : 502);
  }
  const remoteAccess = { mode, label: REMOTE_LABEL[mode], allowed: applied.allowed, changedBy: actorEmail, changedAt: new Date().toISOString() };
  const { nasAppliances } = await getOrgCollections();
  await nasAppliances.updateOne({ _id: res.appliance._id }, { $set: { remoteAccess } });
  await recordNasEvidence({ orgId, applianceId: res.appliance._id, subjectType: "NAS_APPLIANCE", subjectId: res.appliance._id, action: mode === "GATEWAY" ? "REMOTE_ACCESS_ENABLED" : "REMOTE_ACCESS_DISABLED", actorEmail, previousState: before, newState: mode, policy: { kind: "remote-access", mode, allowed: applied.allowed }, data: { note: "SMB/NFS remain private; remote users come through the Inaya gateway/VPN." }, graph: false });
  return { remoteAccess };
}

export async function getNetworkInfo({ orgId, applianceId, membership }) {
  const denied = gate(membership, false);
  if (denied) return denied;
  const res = await loadAppliance({ orgId, applianceId });
  if (res.error) return res;
  return { ...(await res.agent.call("network_info", {})), discovery: res.appliance.discovery || null };
}

export async function setDiscovery({ orgId, applianceId, hostname, mdns = true, membership, actorEmail }) {
  const denied = gate(membership, true);
  if (denied) return denied;
  const res = await loadAppliance({ orgId, applianceId });
  if (res.error) return res;
  try {
    if (hostname) await res.agent.call("set_hostname", { hostname });
    const m = await res.agent.call("mdns_apply", { enabled: !!mdns }, { timeout: 60000 });
    const discovery = { hostname: m.hostname || null, mdns: { supported: m.supported, active: !!m.active, resolvedInsideAppliance: m.resolvedInsideAppliance || null, reason: m.reason || null }, lanVisibilityNote: "Names are advertised on the appliance's own network segment. Behind NAT (e.g. WSL2) they are not visible to other LAN machines." };
    const { nasAppliances } = await getOrgCollections();
    await nasAppliances.updateOne({ _id: res.appliance._id }, { $set: { discovery } });
    await recordNasEvidence({ orgId, applianceId: res.appliance._id, subjectType: "NAS_APPLIANCE", subjectId: res.appliance._id, action: "POLICY_CHANGED", actorEmail, data: { change: "discovery", hostname: discovery.hostname, mdns: discovery.mdns.active }, graph: false });
    return { discovery };
  } catch (err) {
    return fail(err.message, err.code === "BAD_INPUT" ? 400 : 502);
  }
}

// ---------------------------------------------------------------- locking
export async function listLocks({ orgId, applianceId, membership }) {
  const denied = gate(membership, false);
  if (denied) return denied;
  const res = await loadAppliance({ orgId, applianceId });
  if (res.error) return res;
  const [locks, sessions] = await Promise.all([res.agent.call("locks_list", {}), res.agent.call("sessions_list", {})]);
  return { locks: locks.locks, sessions: sessions.sessions, source: "smbstatus (MEASURED)" };
}

/** Plain-language answer to "why can't I save this file?" */
export async function explainLock({ orgId, shareId, relPath, membership }) {
  const denied = gate(membership, false);
  if (denied) return denied;
  const res = await loadShare({ orgId, shareId });
  if (res.error) return res;
  const { locks } = await res.agent.call("locks_list", {});
  const matches = locks.filter((l) => l.path && l.path.endsWith("/" + String(relPath).replace(/^\/+/, "")));
  if (!matches.length) return { locked: false, explanation: "No client currently holds this file open." };
  const m = matches[0];
  return { locked: true, holders: matches.length, sharemode: m.sharemode, accessMask: m.accessMask, oplock: m.oplock, explanation: `This file is open by ${matches.length} client session(s) with ${m.sharemode || "a sharing restriction"}. Ask them to close it, or wait; Samba enforces this so two people cannot corrupt the file by writing at once.` };
}
