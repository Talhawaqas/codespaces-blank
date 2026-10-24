"use client";

// src/components/business/InfrastructureView.js
//
// Sovereign Infrastructure Fabric SOW, Phase 10 (§124-127): the Business
// Workspace console surface over the real infrastructure control plane
// built in Phases 1-8 (node enrollment, compute, block storage, VPCs,
// scheduler, draining). Every value shown here is read from real API
// routes backed by real MongoDB records -- no placeholder numbers.

import { useCallback, useEffect, useState } from "react";
import { useErpSection } from "./erp/ErpNavContext";

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
  { key: "k8s", label: "Kubernetes" },
  { key: "aws", label: "AWS CLI" },
  { key: "lb", label: "Load Balancers" },
];

const K8S_STATUS_COLOR = { PROVISIONING_SERVER: "text-yellow-400", SERVER_READY: "text-green-400", ERROR: "text-red-400", DELETED: "text-slate-500" };

const HEALTH_COLOR = { ACTIVE: "text-green-400", PENDING: "text-yellow-400", UNAVAILABLE: "text-red-400", REVOKED: "text-red-400", UNKNOWN: "text-slate-500" };

export default function InfrastructureView({ orgId, canManage }) {
  const [tab, setTab] = useErpSection("overview", TABS.map((t) => [t.key, t.label]));
  const [clusters, setClusters] = useState([]);
  const [selectedCluster, setSelectedCluster] = useState(null);
  const [nodes, setNodes] = useState([]);
  const [instances, setInstances] = useState([]);
  const [volumes, setVolumes] = useState([]);
  const [vpcs, setVpcs] = useState([]);
  const [k8sClusters, setK8sClusters] = useState([]);
  const [awsKeys, setAwsKeys] = useState([]);
  const [loadBalancers, setLoadBalancers] = useState([]);
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
      const [n, i, v, p, k, l] = await Promise.all([
        j(`/api/orgs/infrastructure/nodes?orgId=${orgId}&clusterId=${selectedCluster}`),
        j(`/api/orgs/infrastructure/compute/instances?orgId=${orgId}&clusterId=${selectedCluster}`),
        j(`/api/orgs/infrastructure/volumes?orgId=${orgId}&clusterId=${selectedCluster}`),
        j(`/api/orgs/infrastructure/networks?orgId=${orgId}&clusterId=${selectedCluster}`),
        j(`/api/orgs/infrastructure/k8s-clusters?orgId=${orgId}&clusterId=${selectedCluster}`),
        j(`/api/orgs/infrastructure/load-balancers?orgId=${orgId}&clusterId=${selectedCluster}`),
      ]);
      setNodes(n.nodes || []);
      setInstances(i.instances || []);
      setVolumes(v.volumes || []);
      setVpcs(p.vpcs || []);
      setK8sClusters(k.k8sClusters || []);
      setLoadBalancers(l.loadBalancers || []);
    } catch (e) { setError(e.message); }
  }, [orgId, selectedCluster]);

  const loadAwsKeys = useCallback(async () => {
    try { const r = await j(`/api/orgs/infrastructure/aws-credentials?orgId=${orgId}`); setAwsKeys(r.accessKeys || []); } catch (e) { setError(e.message); }
  }, [orgId]);

  useEffect(() => { loadClusters(); }, [loadClusters]);
  useEffect(() => { loadAll(); }, [loadAll]);
  useEffect(() => { loadAwsKeys(); }, [loadAwsKeys]);

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

  const createK8sCluster = async () => {
    const nodeId = nodes.find((n) => n.status === "ACTIVE")?.nodeId;
    if (!nodeId) return setError("No ACTIVE node available for this cluster.");
    const vpc = vpcs.find((p) => p.status === "AVAILABLE");
    if (!vpc) return setError("A network (VPC) is required first -- create one on the Networks tab.");
    if (!confirm(`Create a k3s Kubernetes server on network ${vpc.cidr}? This boots a real guest OS and runs the real k3s installer -- it can take a few minutes.`)) return;
    setBusy(true);
    try { await j(`/api/orgs/infrastructure/k8s-clusters`, { method: "POST", body: JSON.stringify({ orgId, clusterId: selectedCluster, nodeId, vpcId: vpc.vpcId }) }); await loadAll(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const addK8sAgent = async (k8sClusterId) => {
    setBusy(true);
    try { await j(`/api/orgs/infrastructure/k8s-clusters/${k8sClusterId}/agents`, { method: "POST", body: JSON.stringify({ orgId }) }); await loadAll(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const deleteK8sCluster = async (k8sClusterId) => {
    if (!confirm("Delete this Kubernetes cluster? This terminates its server and agent instances.")) return;
    setBusy(true);
    try { await j(`/api/orgs/infrastructure/k8s-clusters/${k8sClusterId}`, { method: "DELETE" }); await loadAll(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const downloadKubeconfig = (k8sClusterId) => {
    window.open(`/api/orgs/infrastructure/k8s-clusters/${k8sClusterId}/kubeconfig?orgId=${orgId}`, "_blank");
  };

  const createAwsAccessKey = async () => {
    setBusy(true);
    try {
      const r = await j(`/api/orgs/infrastructure/aws-credentials`, { method: "POST", body: JSON.stringify({ orgId }) });
      const endpoint = typeof window !== "undefined" ? `${window.location.origin}/api/aws-ec2` : "<this app's URL>/api/aws-ec2";
      alert(
        `AWS access key (shown once -- save it now):\n\n` +
        `Access Key ID: ${r.accessKeyId}\n` +
        `Secret Access Key: ${r.secretAccessKey}\n\n` +
        `Configure the real AWS CLI:\n` +
        `aws configure --profile inaya\n` +
        `  (enter the key/secret above, region e.g. us-east-1)\n\n` +
        `Then call it with:\n` +
        `aws ec2 describe-instances --profile inaya --endpoint-url ${endpoint}`
      );
      await loadAwsKeys();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const revokeAwsAccessKey = async (accessKeyId) => {
    if (!confirm(`Revoke access key ${accessKeyId}? Any aws-cli profile using it will stop working immediately.`)) return;
    setBusy(true);
    try { await j(`/api/orgs/infrastructure/aws-credentials/${accessKeyId}`, { method: "DELETE" }); await loadAwsKeys(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const createLoadBalancer = async () => {
    const nodeId = nodes.find((n) => n.status === "ACTIVE")?.nodeId;
    if (!nodeId) return setError("No ACTIVE node available for this cluster.");
    const staticInstances = instances.filter((i) => i.bootsRealGuestOs && i.state === "RUNNING");
    if (staticInstances.length === 0) return setError("No running guest-booting instances to target -- a load balancer needs at least one real (static-IP) instance, e.g. a Kubernetes agent or a plain guest-boot instance.");
    const listenPort = Number(prompt("Listen port?", "8080"));
    const targetPort = Number(prompt("Target port on each instance?", "80"));
    if (!listenPort || !targetPort) return;
    const idsCsv = prompt(`Target instance IDs, comma-separated (available: ${staticInstances.map((i) => i.instanceId.slice(0, 8)).join(", ")}):`, staticInstances.map((i) => i.instanceId).join(","));
    if (!idsCsv) return;
    const targetInstanceIds = idsCsv.split(",").map((s) => s.trim()).filter(Boolean);
    setBusy(true);
    try { await j(`/api/orgs/infrastructure/load-balancers`, { method: "POST", body: JSON.stringify({ orgId, clusterId: selectedCluster, nodeId, listenPort, targetInstanceIds, targetPort }) }); await loadAll(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const deleteLoadBalancer = async (lbId) => {
    if (!confirm("Delete this load balancer?")) return;
    setBusy(true);
    try { await j(`/api/orgs/infrastructure/load-balancers/${lbId}`, { method: "DELETE" }); await loadAll(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const syncLoadBalancer = async (lbId) => {
    setBusy(true);
    try { await j(`/api/orgs/infrastructure/load-balancers/${lbId}?orgId=${orgId}`); await loadAll(); } catch (e) { setError(e.message); } finally { setBusy(false); }
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
        <div className="flex gap-1 border-b border-white/5 overflow-x-auto" data-erp-tabs>
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

      {tab === "k8s" && (
        <div className="space-y-2">
          {canManage && selectedCluster && <button className={btnPrimary} disabled={busy} onClick={createK8sCluster}>+ New Kubernetes cluster</button>}
          {k8sClusters.length === 0 && <p className={`text-sm ${muted}`}>No Kubernetes clusters in this cluster. Real k3s running on real guest VMs -- not a simulation.</p>}
          {k8sClusters.map((k) => (
            <div key={k.k8sClusterId} className={card}>
              <div className="flex justify-between items-center">
                <span className="font-semibold">k3s on {k.serverStaticIp}</span>
                <span className={`text-xs font-bold ${K8S_STATUS_COLOR[k.status] || "text-slate-400"}`}>{k.status}</span>
              </div>
              <div className={`text-xs ${muted} mt-1`}>{k.agentInstanceIds?.length || 0} agent node(s) · API {k.kubeApiEndpoint}</div>
              {k.status === "ERROR" && k.errorMessage && <div className="text-xs text-red-400 mt-1">{k.errorMessage}</div>}
              {canManage && (
                <div className="flex gap-2 mt-2">
                  {k.status === "SERVER_READY" && <button className={btn} disabled={busy} onClick={() => downloadKubeconfig(k.k8sClusterId)}>Download kubeconfig</button>}
                  {k.status === "SERVER_READY" && <button className={btn} disabled={busy} onClick={() => addK8sAgent(k.k8sClusterId)}>+ Add agent</button>}
                  <button className={btn} disabled={busy} onClick={() => deleteK8sCluster(k.k8sClusterId)}>Delete</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === "lb" && (
        <div className="space-y-2">
          <p className={`text-xs ${muted}`}>Real HAProxy processes on your node, balancing across real guest-booting instances -- not a simulated proxy.</p>
          {canManage && selectedCluster && <button className={btnPrimary} disabled={busy} onClick={createLoadBalancer}>+ New load balancer</button>}
          {loadBalancers.length === 0 && <p className={`text-sm ${muted}`}>No load balancers in this cluster.</p>}
          {loadBalancers.map((l) => (
            <div key={l.lbId} className={card}>
              <div className="flex justify-between items-center">
                <span className="font-semibold">:{l.listenPort} &rarr; :{l.targetPort}</span>
                <span className={`text-xs font-bold ${l.status === "ACTIVE" ? "text-green-400" : l.status === "ERROR" ? "text-red-400" : "text-yellow-400"}`}>{l.status}</span>
              </div>
              <div className={`text-xs ${muted} mt-1`}>{l.targetInstanceIds?.length || 0} target(s) · node {l.nodeId.slice(0, 8)}</div>
              {l.status === "ERROR" && l.errorMessage && <div className="text-xs text-red-400 mt-1">{l.errorMessage}</div>}
              {canManage && (
                <div className="flex gap-2 mt-2">
                  {["CREATING", "UPDATING", "DELETING"].includes(l.status) && <button className={btn} disabled={busy} onClick={() => syncLoadBalancer(l.lbId)}>Refresh status</button>}
                  <button className={btn} disabled={busy} onClick={() => deleteLoadBalancer(l.lbId)}>Delete</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === "aws" && (
        <div className="space-y-2">
          <p className={`text-xs ${muted}`}>Real AWS CLI/SDK compatibility -- a tested subset (RunInstances, DescribeInstances, Start/Stop/TerminateInstances, volumes, networks), not full AWS coverage.</p>
          {canManage && <button className={btnPrimary} disabled={busy} onClick={createAwsAccessKey}>+ New access key</button>}
          {awsKeys.length === 0 && <p className={`text-sm ${muted}`}>No AWS access keys yet.</p>}
          {awsKeys.map((k) => (
            <div key={k.accessKeyId} className={card}>
              <div className="flex justify-between"><span className="font-semibold">{k.accessKeyId}</span><span className={`text-xs ${k.status === "ACTIVE" ? "text-green-400" : "text-red-400"}`}>{k.status}</span></div>
              <div className={`text-xs ${muted} mt-1`}>created {when(k.createdAt)}{k.revokedAt ? ` · revoked ${when(k.revokedAt)}` : ""}</div>
              {canManage && k.status === "ACTIVE" && (
                <div className="flex gap-2 mt-2">
                  <button className={btn} disabled={busy} onClick={() => revokeAwsAccessKey(k.accessKeyId)}>Revoke</button>
                </div>
              )}
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
