"use client";

// src/components/business/StorageManagerView.js
//
// Native DePIN Storage Manager — Four High-Impact Business Workspace
// Extensions SOW, Feature 2. Real allocation/replication data; geographic
// preferences and enterprise nodes are honestly labeled (never "Active"
// where the network can't actually enforce them) — see storage-manager.js.

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../EmptyState";

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

function formatBytes(bytes) {
  if (bytes == null) return "Unlimited";
  const gb = bytes / 1073741824;
  return `${gb.toFixed(1)} GB`;
}

export default function StorageManagerView({ orgId }) {
  const [tab, setTab] = useState("overview");
  return (
    <div className="space-y-5">
      <div className="flex bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-xl p-1 w-fit">
        {[["overview", "Overview"], ["nodes", "Enterprise Nodes"], ["policies", "Storage Policy"], ["residency", "Geographic Preference"]].map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)} className={`px-4 py-2 text-xs font-bold uppercase rounded-lg ${tab === key ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>{label}</button>
        ))}
      </div>
      {tab === "overview" && <OverviewTab orgId={orgId} />}
      {tab === "nodes" && <NodesTab orgId={orgId} />}
      {tab === "policies" && <PoliciesTab orgId={orgId} />}
      {tab === "residency" && <ResidencyTab orgId={orgId} />}
    </div>
  );
}

function OverviewTab({ orgId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api(`/api/orgs/storage/overview?orgId=${orgId}`).then(setData).catch((err) => setError(err.message));
  }, [orgId]);

  if (error) return <p className="text-red-400 text-xs">{error}</p>;
  if (!data) return <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-2xl p-4">
          <p className="text-[var(--inaya-text-muted)] text-[11px] font-mono mb-1">Plan</p>
          <p className="text-[var(--inaya-text-primary)] text-lg font-bold">{data.allocation.planName}</p>
        </div>
        <div className="bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-2xl p-4">
          <p className="text-[var(--inaya-text-muted)] text-[11px] font-mono mb-1">Used</p>
          <p className="text-[var(--inaya-text-primary)] text-lg font-bold">{formatBytes(data.allocation.usedBytes)}</p>
        </div>
        <div className="bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-2xl p-4">
          <p className="text-[var(--inaya-text-muted)] text-[11px] font-mono mb-1">Available</p>
          <p className="text-[var(--inaya-text-primary)] text-lg font-bold">{formatBytes(data.allocation.availableBytes)}</p>
        </div>
        <div className="bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-2xl p-4">
          <p className="text-[var(--inaya-text-muted)] text-[11px] font-mono mb-1">Target Replicas</p>
          <p className="text-[var(--inaya-text-primary)] text-lg font-bold tabular-nums">{data.replication.targetReplicaCount}</p>
        </div>
      </div>

      <div className="bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-2xl p-4">
        <p className="text-[var(--inaya-text-muted)] text-[11px] font-bold uppercase mb-3">Replication Health {data.replication.truncated && <span className="text-amber-400">(sampled {data.replication.documentsSampled} of {data.replication.totalDocumentCount})</span>}</p>
        <div className="grid grid-cols-3 gap-3 text-center">
          <div><p className="text-emerald-400 text-xl font-bold tabular-nums">{data.replication.fullyReplicated}</p><p className="text-[var(--inaya-text-muted)] text-[11px]">Fully Replicated</p></div>
          <div><p className="text-amber-400 text-xl font-bold tabular-nums">{data.replication.degraded}</p><p className="text-[var(--inaya-text-muted)] text-[11px]">Degraded</p></div>
          <div><p className="text-red-400 text-xl font-bold tabular-nums">{data.replication.atRisk}</p><p className="text-[var(--inaya-text-muted)] text-[11px]">At Risk</p></div>
        </div>
        <p className="text-[var(--inaya-text-muted)] text-[11px] mt-3">Last telemetry sync: {data.replication.lastTelemetrySyncAt ? new Date(data.replication.lastTelemetrySyncAt).toLocaleString() : "Never"}</p>
      </div>

      {data.resiliencePolicies.length > 0 && (
        <div className="bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-2xl p-4">
          <p className="text-[var(--inaya-text-muted)] text-[11px] font-bold uppercase mb-3">Resilience Policies</p>
          <div className="space-y-1.5">
            {data.resiliencePolicies.map((p) => (
              <div key={p.policyId} className="flex items-center justify-between text-xs">
                <span className="text-[var(--inaya-text-primary)]">{p.name}</span>
                <span className="text-[var(--inaya-text-muted)]">{p.resilienceState}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function NodesTab({ orgId }) {
  const [nodes, setNodes] = useState(null);
  const [error, setError] = useState("");
  const [wallet, setWallet] = useState("");
  const [capacityGB, setCapacityGB] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    try {
      setNodes((await api(`/api/orgs/storage/nodes?orgId=${orgId}`)).nodes);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  async function handleRegister(e) {
    e.preventDefault();
    if (!wallet.trim() || !capacityGB) return;
    setSubmitting(true); setError("");
    try {
      await api("/api/orgs/storage/nodes", { method: "POST", body: JSON.stringify({ orgId, nodeWallet: wallet.trim(), capacityGB: Number(capacityGB) }) });
      setWallet(""); setCapacityGB("");
      load();
    } catch (err) { setError(err.message); } finally { setSubmitting(false); }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={handleRegister} className="bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-2xl p-4 flex flex-wrap gap-2 items-end">
        <div className="flex-1 min-w-[200px]">
          <label className="text-[11px] text-[var(--inaya-text-muted)] block mb-1">Node wallet</label>
          <input value={wallet} onChange={(e) => setWallet(e.target.value)} placeholder="0x…" className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)] font-mono" />
        </div>
        <div className="w-32">
          <label className="text-[11px] text-[var(--inaya-text-muted)] block mb-1">Capacity (GB)</label>
          <input value={capacityGB} onChange={(e) => setCapacityGB(e.target.value)} type="number" min="1" className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]" />
        </div>
        <button disabled={submitting} className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg disabled:opacity-40">{submitting ? "Registering…" : "Register node"}</button>
      </form>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-2xl p-5">
        {!nodes ? <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p> : nodes.length === 0 ? (
          <EmptyState compact icon="🖥️" description="No enterprise-owned storage nodes registered yet." />
        ) : (
          <div className="space-y-2">
            {nodes.map((n) => (
              <div key={n.id} className="flex items-center justify-between bg-black/20 border border-white/5 rounded-lg p-3 text-xs">
                <div>
                  <span className="text-[var(--inaya-text-primary)] font-mono">{n.nodeWallet.slice(0, 10)}…</span>
                  <p className="text-[var(--inaya-text-muted)] mt-0.5">{n.capacityGB} GB · {n.status}</p>
                </div>
                <span className="text-amber-400 text-[10px] font-bold uppercase">Routing not yet supported</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PoliciesTab({ orgId }) {
  const [policies, setPolicies] = useState(null);
  const [error, setError] = useState("");
  const [key, setKey] = useState("");
  const [classification, setClassification] = useState("");
  const [regions, setRegions] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    try {
      setPolicies((await api(`/api/orgs/storage/policies?orgId=${orgId}`)).policies);
    } catch (err) { setError(err.message); }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  async function handleCreate(e) {
    e.preventDefault();
    if (!key.trim()) return;
    setSubmitting(true); setError("");
    try {
      await api("/api/orgs/storage/policies", {
        method: "POST",
        body: JSON.stringify({ orgId, key: key.trim(), dataClassification: classification.trim() || undefined, allowedRegions: regions.split(",").map((r) => r.trim()).filter(Boolean) }),
      });
      setKey(""); setClassification(""); setRegions("");
      load();
    } catch (err) { setError(err.message); } finally { setSubmitting(false); }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={handleCreate} className="bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-2xl p-4 space-y-2">
        <p className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)]">New policy version</p>
        <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="Policy key (e.g. customer-data)" className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]" />
        <input value={classification} onChange={(e) => setClassification(e.target.value)} placeholder="Data classification (e.g. CONFIDENTIAL)" className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]" />
        <input value={regions} onChange={(e) => setRegions(e.target.value)} placeholder="Allowed regions, comma-separated" className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]" />
        <button disabled={submitting || !key.trim()} className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg disabled:opacity-40">{submitting ? "Saving…" : "Create policy version"}</button>
      </form>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-2xl p-5">
        {!policies ? <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p> : policies.length === 0 ? (
          <EmptyState compact icon="📋" description="No storage policies defined yet." />
        ) : (
          <div className="space-y-2">
            {policies.map((p) => (
              <div key={p.id} className="bg-black/20 border border-white/5 rounded-lg p-3 text-xs">
                <span className="text-[var(--inaya-text-primary)] font-bold">{p.key} · v{p.version}</span>
                <p className="text-[var(--inaya-text-muted)] mt-0.5">{p.dataClassification || "—"} · Regions: {(p.allowedRegions || []).join(", ") || "any"}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ResidencyTab({ orgId }) {
  const [policy, setPolicy] = useState(null);
  const [error, setError] = useState("");
  const [primaryRegion, setPrimaryRegion] = useState("");
  const [failoverRegion, setFailoverRegion] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await api(`/api/orgs/data-residency-policy?orgId=${orgId}`);
      setPolicy(d.policy);
      setPrimaryRegion(d.policy?.primaryRegion || "");
      setFailoverRegion(d.policy?.failoverRegion || "");
    } catch (err) { setError(err.message); }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  async function handleSave(e) {
    e.preventDefault();
    setSubmitting(true); setError("");
    try {
      await api("/api/orgs/data-residency-policy", { method: "POST", body: JSON.stringify({ orgId, primaryRegion: primaryRegion.trim() || undefined, failoverRegion: failoverRegion.trim() || undefined }) });
      load();
    } catch (err) { setError(err.message); } finally { setSubmitting(false); }
  }

  return (
    <div className="space-y-4">
      <div className="bg-amber-400/10 border border-amber-400/30 rounded-xl p-3">
        <p className="text-amber-400 text-xs font-semibold">Declared preference only — no pinning provider routes by region today. This is never enforced, only recorded.</p>
      </div>
      <form onSubmit={handleSave} className="bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-2xl p-4 space-y-2">
        <input value={primaryRegion} onChange={(e) => setPrimaryRegion(e.target.value)} placeholder="Primary region (e.g. us-east)" className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]" />
        <input value={failoverRegion} onChange={(e) => setFailoverRegion(e.target.value)} placeholder="Failover region (optional)" className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]" />
        <button disabled={submitting} className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg disabled:opacity-40">{submitting ? "Saving…" : "Save preference"}</button>
      </form>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      {policy?.primaryRegion && (
        <div className="bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-2xl p-4 text-xs">
          <span className="text-[11px] font-bold uppercase px-2 py-0.5 rounded-full border bg-white/5 text-[var(--inaya-text-muted)] border-white/10">Declared</span>
          <p className="text-[var(--inaya-text-primary)] mt-2">Primary: {policy.primaryRegion} {policy.failoverRegion && `· Failover: ${policy.failoverRegion}`}</p>
        </div>
      )}
    </div>
  );
}
