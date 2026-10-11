"use client";

// src/components/business/InfrastructureView.js
//
// Sovereign Infrastructure Fabric SOW, Phase 10 (§124-127): the Business
// Workspace console surface over the real infrastructure control plane
// built in Phases 1-8 (node enrollment, compute, block storage, VPCs,
// scheduler, draining). Every value shown here is read from real API
// routes backed by real MongoDB records -- no placeholder numbers.

import { useCallback, useEffect, useState } from "react";

const card = "bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] rounded-lg p-4";
const muted = "text-[var(--inaya-text-muted)]";
const btn = "text-[10px] font-bold uppercase bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] px-2 py-1 rounded-lg text-[var(--inaya-text-primary)] hover:bg-[var(--inaya-overlay-10)] disabled:opacity-40";
const btnPrimary = "text-[10px] font-bold uppercase bg-[#00f2fe]/10 border border-[#00f2fe]/30 px-2 py-1 rounded-lg text-[#00f2fe] hover:bg-[#00f2fe]/20 disabled:opacity-40";
const input = "bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] rounded px-2 py-1 text-xs text-[var(--inaya-text-primary)]";
const when = (iso) => { try { return iso ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "-"; } catch { return "-"; } };

const j = async (path, opts = {}) => {
  const r = await fetch(path, { credentials: "include", headers: { "Content-Type": "application/json" }, ...opts });
  let d = {};
  try { d = await r.json(); } catch { /* empty */ }
  if (!r.ok) throw Object.assign(new Error(d.error || `Request failed (${r.status})`), { status: r.status, data: d });
  return d;
};

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "clusters", label: "Clusters" },
  { key: "nodes", label: "Nodes" },
  { key: "compute", label: "Compute" },
  { key: "volumes", label: "Volumes" },
  { key: "networks", label: "Networks" },
];

const HEALTH_COLOR = { ACTIVE: "text-green-400", PENDING: "text-yellow-400", UNAVAILABLE: "text-red-400", REVOKED: "text-red-400", UNKNOWN: "text-slate-500" };

export default function InfrastructureView({ orgId, canManage }) {
  const [tab, setTab] = useState("overview");
  const [clusters, setClusters] = useState([]);
  const [selectedCluster, setSelectedCluster] = useState(null);
  const [nodes, setNodes] = useState([]);
  const [instances, setInstances] = useState([]);
  const [volumes, setVolumes] = useState([]);
  const [vpcs, setVpcs] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const loadClusters = useCallback(async () => {
    try {
      const r = await j(`/api/orgs/infrastructure/clusters?orgId=${orgId}`);
      setClusters(r.clusters || []);
      if (!selectedCluster && r.clusters?.[0]) setSelectedCluster(r.clusters[0].clusterId);
    } catch (e) { setError(e.message); }
  }, [orgId, selectedCluster]);

  const loadAll = useCallback(async () => {
    if (!selectedCluster) return;
    try {
      const [n, i, v, p] = await Promise.all([
        j(`/api/orgs/infrastructure/nodes?orgId=${orgId}&clusterId=${selectedCluster}`),
        j(`/api/orgs/infrastructure/compute/instances?orgId=${orgId}&clusterId=${selectedCluster}`),
        j(`/api/orgs/infrastructure/volumes?orgId=${orgId}&clusterId=${selectedCluster}`),
        j(`/api/orgs/infrastructure/networks?orgId=${orgId}&clusterId=${selectedCluster}`),
      ]);
      setNodes(n.nodes || []);
      setInstances(i.instances || []);
      setVolumes(v.volumes || []);
      setVpcs(p.vpcs || []);
    } catch (e) { setError(e.message); }
  }, [orgId, selectedCluster]);

  useEffect(() => { loadClusters(); }, [loadClusters]);
  useEffect(() => { loadAll(); }, [loadAll]);

  const createCluster = async () => {
    const name = prompt("Cluster name?");
    if (!name) return;
    setBusy(true);
    try { await j(`/api/orgs/infrastructure/clusters`, { method: "POST", body: JSON.stringify({ orgId, name }) }); await loadClusters(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const mintEnrollmentToken = async () => {
    if (!selectedCluster) return;
    setBusy(true);
    try {
      const r = await j(`/api/orgs/infrastructure/clusters/${selectedCluster}/enrollment-tokens`, { method: "POST", body: JSON.stringify({ orgId }) });
      alert(`One-time enrollment token (expires ${when(r.expiresAt)}):\n\n${r.token}\n\nRun on the new host:\ninaya-infra node enroll --control-plane-url <this app's URL> --token ${r.token} --data-dir /var/lib/inaya-infra`);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const nodeAction = async (nodeId, action) => {
    setBusy(true);
    try { await j(`/api/orgs/infrastructure/nodes/${nodeId}/${action}`, { method: "POST", body: JSON.stringify({ orgId }) }); await loadAll(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const instanceAction = async (instanceId, action) => {
    setBusy(true);
    try { await j(`/api/orgs/infrastructure/compute/instances/${instanceId}/${action}`, { method: "POST", body: JSON.stringify({ orgId }) }); await loadAll(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const createVolume = async () => {
    const nodeId = nodes.find((n) => n.status === "ACTIVE")?.nodeId;
    if (!nodeId) return setError("No ACTIVE node available for this cluster.");
    const sizeGib = Number(prompt("Volume size, GiB?", "10"));
    if (!sizeGib) return;
    setBusy(true);
    try { await j(`/api/orgs/infrastructure/volumes`, { method: "POST", body: JSON.stringify({ orgId, clusterId: selectedCluster, nodeId, sizeGib }) }); await loadAll(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const createInstance = async () => {
    const nodeId = nodes.find((n) => n.status === "ACTIVE")?.nodeId;
    if (!nodeId) return setError("No ACTIVE node available for this cluster.");
    const name = prompt("Instance name?");
    if (!name) return;
    setBusy(true);
    try { await j(`/api/orgs/infrastructure/compute/instances`, { method: "POST", body: JSON.stringify({ orgId, clusterId: selectedCluster, nodeId, name, vcpu: 1, memoryMib: 512 }) }); await loadAll(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const createVpc = async () => {
    const nodeId = nodes.find((n) => n.status === "ACTIVE")?.nodeId;
    if (!nodeId) return setError("No ACTIVE node available for this cluster.");
    const cidr = prompt("VPC CIDR?", "10.80.0.1/24");
    if (!cidr) return;
    setBusy(true);
    try { await j(`/api/orgs/infrastructure/networks`, { method: "POST", body: JSON.stringify({ orgId, clusterId: selectedCluster, nodeId, cidr }) }); await loadAll(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const totalCapacity = nodes.reduce((acc, n) => {
    if (!n.capacity) return acc;
    acc.vcpu += n.capacity.hostVcpu || 0;
    acc.memoryMib += n.capacity.hostMemoryMib || 0;
    return acc;
  }, { vcpu: 0, memoryMib: 0 });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex gap-1 border-b border-white/5 overflow-x-auto">
          {TABS.map((t) => (
            <button key={t.key} onClick={() => setTab(t.key)} className={`px-4 py-2.5 text-xs font-bold uppercase tracking-wide whitespace-nowrap border-b-2 transition-colors ${tab === t.key ? "text-[#00f2fe] border-[#00f2fe]" : `${muted} border-transparent hover:text-slate-200`}`}>
              {t.label}
            </button>
          ))}
        </div>
        {clusters.length > 0 && (
          <select className={input} value={selectedCluster || ""} onChange={(e) => setSelectedCluster(e.target.value)}>
            {clusters.map((c) => <option key={c.clusterId} value={c.clusterId}>{c.name} ({c.mode})</option>)}
          </select>
        )}
      </div>

      {error && <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded px-3 py-2">{error} <button className="underline ml-2" onClick={() => setError("")}>dismiss</button></div>}

      {tab === "overview" && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className={card}><div className={`text-xs ${muted}`}>Clusters</div><div className="text-2xl font-bold">{clusters.length}</div></div>
          <div className={card}><div className={`text-xs ${muted}`}>Nodes</div><div className="text-2xl font-bold">{nodes.length}</div><div className={`text-[10px] ${muted}`}>{nodes.filter((n) => n.status === "ACTIVE").length} active</div></div>
          <div className={card}><div className={`text-xs ${muted}`}>Total vCPU (reported)</div><div className="text-2xl font-bold">{totalCapacity.vcpu}</div></div>
          <div className={card}><div className={`text-xs ${muted}`}>Total memory (reported)</div><div className="text-2xl font-bold">{(totalCapacity.memoryMib / 1024).toFixed(1)} GiB</div></div>
          <div className={card}><div className={`text-xs ${muted}`}>Compute instances</div><div className="text-2xl font-bold">{instances.length}</div></div>
          <div className={card}><div className={`text-xs ${muted}`}>Volumes</div><div className="text-2xl font-bold">{volumes.length}</div></div>
          <div className={card}><div className={`text-xs ${muted}`}>Networks</div><div className="text-2xl font-bold">{vpcs.length}</div></div>
        </div>
      )}

      {tab === "clusters" && (
        <div className="space-y-2">
          {canManage && <button className={btnPrimary} disabled={busy} onClick={createCluster}>+ New cluster</button>}
          {clusters.length === 0 && <p className={`text-sm ${muted}`}>No clusters yet.</p>}
          {clusters.map((c) => (
            <div key={c.clusterId} className={card}>
              <div className="flex justify-between"><span className="font-semibold">{c.name}</span><span className={`text-xs ${muted}`}>{c.mode}</span></div>
              <div className={`text-xs ${muted} mt-1`}>{c.nodeIds?.length || 0} node(s) · created {when(c.createdAt)}</div>
            </div>
          ))}
        </div>
      )}

      {tab === "nodes" && (
        <div className="space-y-2">
          {canManage && selectedCluster && <button className={btnPrimary} disabled={busy} onClick={mintEnrollmentToken}>+ Enroll a node</button>}
          {nodes.length === 0 && <p className={`text-sm ${muted}`}>No nodes enrolled in this cluster.</p>}
          {nodes.map((n) => (
            <div key={n.nodeId} className={card}>
              <div className="flex justify-between items-center">
                <span className="font-semibold">{n.hostname}</span>
                <span className={`text-xs font-bold ${HEALTH_COLOR[n.health] || "text-slate-400"}`}>{n.health}</span>
              </div>
              <div className={`text-xs ${muted} mt-1`}>
                {n.capacity ? `${n.capacity.hostVcpu} vCPU · ${(n.capacity.hostMemoryMib / 1024).toFixed(1)} GiB · ${n.runtimeVersion || "?"} · ${n.kernelVersion || "?"}` : "No capacity report yet"}
              </div>
              <div className={`text-[10px] ${muted}`}>Last heartbeat: {when(n.lastHeartbeatAt)}</div>
              {canManage && (
                <div className="flex gap-2 mt-2">
                  {n.status === "PENDING" && <button className={btn} disabled={busy} onClick={() => nodeAction(n.nodeId, "approve")}>Approve</button>}
                  {n.status === "ACTIVE" && <button className={btn} disabled={busy} onClick={() => nodeAction(n.nodeId, "drain")}>Drain</button>}
                  {n.status !== "REVOKED" && <button className={btn} disabled={busy} onClick={() => nodeAction(n.nodeId, "revoke")}>Revoke</button>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === "compute" && (
        <div className="space-y-2">
          {canManage && selectedCluster && <button className={btnPrimary} disabled={busy} onClick={createInstance}>+ New instance</button>}
          {instances.length === 0 && <p className={`text-sm ${muted}`}>No compute instances in this cluster.</p>}
          {instances.map((i) => (
            <div key={i.instanceId} className={card}>
              <div className="flex justify-between"><span className="font-semibold">{i.name}</span><span className={`text-xs ${muted}`}>{i.state}</span></div>
              <div className={`text-xs ${muted} mt-1`}>{i.vcpu} vCPU · {i.memoryMib} MiB · node {i.nodeId.slice(0, 8)}{i.volumeId ? ` · volume ${i.volumeId.slice(0, 8)}` : ""}{i.vpcId ? ` · network ${i.vpcId.slice(0, 8)}` : ""}</div>
              {canManage && i.state !== "TERMINATED" && (
                <div className="flex gap-2 mt-2">
                  <button className={btn} disabled={busy} onClick={() => instanceAction(i.instanceId, "start")}>Start</button>
                  <button className={btn} disabled={busy} onClick={() => instanceAction(i.instanceId, "stop")}>Stop</button>
                  <button className={btn} disabled={busy} onClick={() => instanceAction(i.instanceId, "reboot")}>Reboot</button>
                  <button className={btn} disabled={busy} onClick={() => instanceAction(i.instanceId, "terminate")}>Terminate</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === "volumes" && (
        <div className="space-y-2">
          {canManage && selectedCluster && <button className={btnPrimary} disabled={busy} onClick={createVolume}>+ New volume</button>}
          {volumes.length === 0 && <p className={`text-sm ${muted}`}>No volumes in this cluster.</p>}
          {volumes.map((v) => (
            <div key={v.volumeId} className={card}>
              <div className="flex justify-between"><span className="font-semibold">{v.volumeId.slice(0, 8)}</span><span className={`text-xs ${muted}`}>{v.status}</span></div>
              <div className={`text-xs ${muted} mt-1`}>{v.sizeGib} GiB · node {v.nodeId.slice(0, 8)}</div>
            </div>
          ))}
        </div>
      )}

      {tab === "networks" && (
        <div className="space-y-2">
          {canManage && selectedCluster && <button className={btnPrimary} disabled={busy} onClick={createVpc}>+ New network</button>}
          {vpcs.length === 0 && <p className={`text-sm ${muted}`}>No networks in this cluster.</p>}
          {vpcs.map((p) => (
            <div key={p.vpcId} className={card}>
              <div className="flex justify-between"><span className="font-semibold">{p.cidr}</span><span className={`text-xs ${muted}`}>{p.status}</span></div>
              <div className={`text-xs ${muted} mt-1`}>node {p.nodeId.slice(0, 8)} · {p.securityGroupRules?.length || 0} security rule(s)</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
