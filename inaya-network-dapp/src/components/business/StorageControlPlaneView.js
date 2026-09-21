"use client";

// src/components/business/StorageControlPlaneView.js
//
// IBM Cloud VPC Storage Gap Expansion SOW. Covers the core flows: storage
// resources (volumes/file shares, create/attach/detach/expand), snapshots
// (create/restore/delete), and the backup policy engine (policies, plans,
// run now, health). Cross-org snapshot sharing and mount-target management
// are API-only for now (not built into this view), matching this
// codebase's own established "ship a complete, tested API surface first"
// precedent.
//
// Every "logical only" / "declared, not physical" disclosure from the
// backend is surfaced here verbatim rather than hidden -- a user should
// never come away thinking a volume is a real attachable disk or a file
// share is a real NFS mount.

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../EmptyState";

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

const HEALTH_STYLES = {
  HEALTHY: "bg-emerald-400/10 text-emerald-400 border-emerald-400/30",
  WARNING: "bg-amber-400/10 text-amber-400 border-amber-400/30",
  DEGRADED: "bg-amber-400/10 text-amber-400 border-amber-400/30",
  FAILED: "bg-red-400/10 text-red-400 border-red-400/30",
  PAUSED: "border-white/10 text-[var(--inaya-text-muted)]",
  UNKNOWN: "border-white/10 text-[var(--inaya-text-muted)]",
};

function ResourceRow({ orgId, resource, onChanged }) {
  const [expanded, setExpanded] = useState(false);
  const [snapshots, setSnapshots] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [attachTarget, setAttachTarget] = useState("");

  const loadSnapshots = useCallback(async () => {
    try {
      setSnapshots((await api(`/api/orgs/storage/snapshots?orgId=${orgId}&resourceId=${resource._id}`)).snapshots);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId, resource._id]);

  useEffect(() => { if (expanded) loadSnapshots(); }, [expanded, loadSnapshots]);

  async function createSnap() {
    setBusy(true); setError("");
    try {
      await api("/api/orgs/storage/snapshots", { method: "POST", body: JSON.stringify({ orgId, resourceId: resource._id }) });
      loadSnapshots();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function restore(snapshotId) {
    setBusy(true); setError("");
    try {
      await api(`/api/orgs/storage/snapshots/${snapshotId}/restore`, { method: "POST", body: JSON.stringify({ orgId }) });
      loadSnapshots();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function attach() {
    if (!attachTarget.trim()) return;
    setBusy(true); setError("");
    try {
      await api(`/api/orgs/storage/resources/${resource._id}/attach`, { method: "POST", body: JSON.stringify({ orgId, attachedTo: attachTarget.trim() }) });
      setAttachTarget("");
      onChanged();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function detach() {
    setBusy(true); setError("");
    try {
      await api(`/api/orgs/storage/resources/${resource._id}/detach`, { method: "POST", body: JSON.stringify({ orgId }) });
      onChanged();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function remove() {
    setBusy(true); setError("");
    try {
      await api(`/api/orgs/storage/resources/${resource._id}`, { method: "DELETE", body: JSON.stringify({ orgId }) });
      onChanged();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  return (
    <div className="bg-black/20 border border-white/5 rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-[13px] text-[var(--inaya-text-primary)] font-bold truncate">{resource.name}</p>
            <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded-full border border-white/10 text-[var(--inaya-text-muted)] shrink-0">{resource.type}</span>
            {resource.type === "volume" && (
              <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded-full border shrink-0 ${resource.attachmentState === "ATTACHED" ? "bg-emerald-400/10 text-emerald-400 border-emerald-400/30" : "border-white/10 text-[var(--inaya-text-muted)]"}`}>
                {resource.attachmentState}
              </span>
            )}
          </div>
          <p className="text-[11px] text-[var(--inaya-text-muted)] font-mono truncate">region: {resource.region} · {resource.physicalCapability.replace(/_/g, " ")}{resource.attachedTo ? ` · in use by ${resource.attachedTo}` : ""}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={createSnap} disabled={busy} className="text-[11px] font-bold uppercase px-2.5 py-1.5 rounded-md bg-[#00f2fe]/10 text-[#00f2fe] border border-[#00f2fe]/30 disabled:opacity-40">Snapshot</button>
          {resource.type === "volume" && resource.attachmentState === "ATTACHED" && (
            <button onClick={detach} disabled={busy} className="text-[10px] font-bold uppercase text-[#00f2fe] disabled:opacity-40">Detach</button>
          )}
          <button onClick={remove} disabled={busy} className="text-[10px] font-bold uppercase text-red-400 disabled:opacity-40">Delete</button>
          <button onClick={() => setExpanded((v) => !v)} className="text-[10px] font-bold uppercase text-[var(--inaya-text-muted)]">{expanded ? "Hide" : "Snapshots"}</button>
        </div>
      </div>
      {error && <p className="text-red-400 text-[11px]">{error}</p>}
      {resource.type === "volume" && resource.attachmentState !== "ATTACHED" && (
        <div className="flex items-center gap-2">
          <input placeholder="Attach to (label)" value={attachTarget} onChange={(e) => setAttachTarget(e.target.value)} className="bg-black/30 border border-white/10 rounded-md text-[11px] px-2 py-1 text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
          <button onClick={attach} disabled={busy || !attachTarget.trim()} className="text-[10px] font-bold uppercase text-[#00f2fe] disabled:opacity-40">Attach</button>
        </div>
      )}
      {expanded && (
        !snapshots ? <p className="text-[var(--inaya-text-muted)] font-mono text-xs">Loading…</p> :
        snapshots.length === 0 ? <p className="text-[var(--inaya-text-muted)] text-[11px]">No snapshots yet.</p> :
        <div className="space-y-1">
          {snapshots.map((s) => (
            <div key={s._id} className="bg-black/30 border border-white/10 rounded-md p-2 text-[11px] font-mono flex items-center justify-between gap-2">
              <span className="text-[var(--inaya-text-muted)] truncate">{new Date(s.createdAt).toLocaleString()} · {s.manifest?.length ?? 0} object(s)</span>
              <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded-full border border-white/10 text-[var(--inaya-text-muted)] shrink-0">{s.status}</span>
              <button onClick={() => restore(s._id)} disabled={busy || s.status !== "AVAILABLE"} className="text-[10px] font-bold uppercase text-[#00f2fe] disabled:opacity-40 shrink-0">Restore</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CreateResourceForm({ orgId, onChanged }) {
  const [type, setType] = useState("volume");
  const [name, setName] = useState("");
  const [capacity, setCapacity] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function create(e) {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      await api("/api/orgs/storage/resources", { method: "POST", body: JSON.stringify({ orgId, type, name: name.trim(), capacity: capacity ? Number(capacity) : undefined }) });
      setName(""); setCapacity("");
      onChanged();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  return (
    <form onSubmit={create} className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <select value={type} onChange={(e) => setType(e.target.value)} className="bg-black/30 border border-white/10 rounded-md text-xs px-2 py-1.5 text-[var(--inaya-text-primary)]">
          <option value="volume">Volume</option>
          <option value="fileShare">File Share</option>
        </select>
        <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input placeholder="Capacity (GB, optional)" type="number" value={capacity} onChange={(e) => setCapacity(e.target.value)} className="w-40 bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <button type="submit" disabled={busy || !name.trim()} className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg disabled:opacity-40">
          {busy ? "Creating…" : "Create"}
        </button>
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}
    </form>
  );
}

function PlanRow({ orgId, policyId, plan, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function runNow() {
    setBusy(true); setError("");
    try {
      await api(`/api/orgs/storage/backup-plans/${plan._id}/run`, { method: "POST", body: JSON.stringify({ orgId }) });
      onChanged();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  return (
    <div className="bg-black/30 border border-white/10 rounded-md p-2 flex items-center justify-between gap-2">
      <span className="text-[11px] font-mono text-[var(--inaya-text-muted)]">{plan.frequency} · retain {plan.retentionCount}</span>
      <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded-full border shrink-0 ${HEALTH_STYLES[plan.health] || ""}`}>{plan.health}</span>
      <button onClick={runNow} disabled={busy} className="text-[10px] font-bold uppercase text-[#00f2fe] disabled:opacity-40 shrink-0">Run now</button>
      {error && <span className="text-red-400 text-[10px]">{error}</span>}
    </div>
  );
}

function PolicyRow({ orgId, policy, onChanged }) {
  const [plans, setPlans] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [frequency, setFrequency] = useState("daily");
  const [retentionCount, setRetentionCount] = useState(7);

  const loadPlans = useCallback(async () => {
    try {
      setPlans((await api(`/api/orgs/storage/backup-policies/${policy._id}/plans?orgId=${orgId}`)).plans);
    } catch (err) { setError(err.message); }
  }, [orgId, policy._id]);

  useEffect(() => { if (expanded) loadPlans(); }, [expanded, loadPlans]);

  async function toggleEnabled() {
    setBusy(true); setError("");
    try {
      await api(`/api/orgs/storage/backup-policies/${policy._id}`, { method: "PATCH", body: JSON.stringify({ orgId, enabled: !policy.enabled }) });
      onChanged();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function addPlan(e) {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      await api(`/api/orgs/storage/backup-policies/${policy._id}/plans`, { method: "POST", body: JSON.stringify({ orgId, frequency, retentionCount: Number(retentionCount) }) });
      loadPlans();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  return (
    <div className="bg-black/20 border border-white/5 rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-[13px] text-[var(--inaya-text-primary)] font-bold truncate">{policy.name}</p>
            <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded-full border shrink-0 ${policy.enabled ? "bg-emerald-400/10 text-emerald-400 border-emerald-400/30" : "border-white/10 text-[var(--inaya-text-muted)]"}`}>{policy.enabled ? "ENABLED" : "PAUSED"}</span>
          </div>
          <p className="text-[11px] text-[var(--inaya-text-muted)] font-mono truncate">selector: {JSON.stringify(policy.tagSelector)}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={toggleEnabled} disabled={busy} className="text-[10px] font-bold uppercase text-[#00f2fe] disabled:opacity-40">{policy.enabled ? "Pause" : "Resume"}</button>
          <button onClick={() => setExpanded((v) => !v)} className="text-[10px] font-bold uppercase text-[var(--inaya-text-muted)]">{expanded ? "Hide" : "Plans"}</button>
        </div>
      </div>
      {error && <p className="text-red-400 text-[11px]">{error}</p>}
      {expanded && (
        <div className="space-y-2">
          {!plans ? <p className="text-[var(--inaya-text-muted)] font-mono text-xs">Loading…</p> :
            plans.length === 0 ? <p className="text-[var(--inaya-text-muted)] text-[11px]">No plans yet.</p> :
            <div className="space-y-1">{plans.map((p) => <PlanRow key={p._id} orgId={orgId} policyId={policy._id} plan={p} onChanged={loadPlans} />)}</div>
          }
          <form onSubmit={addPlan} className="flex items-center gap-2">
            <select value={frequency} onChange={(e) => setFrequency(e.target.value)} className="bg-black/30 border border-white/10 rounded-md text-[11px] px-2 py-1 text-[var(--inaya-text-primary)]">
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
              <option value="longTerm">Long-term</option>
            </select>
            <input type="number" min="1" value={retentionCount} onChange={(e) => setRetentionCount(e.target.value)} className="w-20 bg-black/30 border border-white/10 rounded-md text-[11px] px-2 py-1 text-[var(--inaya-text-primary)]" />
            <span className="text-[10px] text-[var(--inaya-text-muted)]">retain</span>
            <button type="submit" disabled={busy} className="text-[10px] font-bold uppercase text-[#00f2fe] disabled:opacity-40">Add Plan</button>
          </form>
        </div>
      )}
    </div>
  );
}

export default function StorageControlPlaneView({ orgId }) {
  const [resources, setResources] = useState(null);
  const [policies, setPolicies] = useState(null);
  const [error, setError] = useState("");
  const [policyName, setPolicyName] = useState("");
  const [policySelector, setPolicySelector] = useState("");
  const [policyBusy, setPolicyBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [resData, polData] = await Promise.all([
        api(`/api/orgs/storage/resources?orgId=${orgId}`),
        api(`/api/orgs/storage/backup-policies?orgId=${orgId}`),
      ]);
      setResources(resData.resources);
      setPolicies(polData.policies);
    } catch (err) { setError(err.message); }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  async function createPolicy(e) {
    e.preventDefault();
    setPolicyBusy(true); setError("");
    try {
      let tagSelector = {};
      if (policySelector.trim()) {
        const [k, v] = policySelector.split("=").map((s) => s.trim());
        if (k && v) tagSelector = { [k]: v };
      }
      await api("/api/orgs/storage/backup-policies", { method: "POST", body: JSON.stringify({ orgId, name: policyName.trim(), tagSelector }) });
      setPolicyName(""); setPolicySelector("");
      load();
    } catch (err) { setError(err.message); } finally { setPolicyBusy(false); }
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-[var(--inaya-text-primary)] font-bold text-sm">Storage Control Plane</h3>
        <p className="text-[var(--inaya-text-muted)] text-xs mt-0.5">
          Volumes and file shares are logical, taggable storage containers backed by real Inaya storage — not real attachable block devices or NFS mounts (Inaya has no compute layer for a device to physically attach to). Snapshots and backup policies are real, tested, and durable.
        </p>
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}

      {resources === null || policies === null ? (
        <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>
      ) : (
        <>
          <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5 space-y-4">
            <p className="text-[var(--inaya-text-primary)] font-bold text-sm">Storage Resources</p>
            {resources.length === 0 ? (
              <EmptyState compact icon="💾" description="No storage resources yet." />
            ) : (
              <div className="space-y-1.5">{resources.map((r) => <ResourceRow key={r._id} orgId={orgId} resource={r} onChanged={load} />)}</div>
            )}
            <div className="border-t border-white/5 pt-4">
              <p className="text-[var(--inaya-text-muted)] text-[11px] uppercase font-bold mb-2">Create a resource</p>
              <CreateResourceForm orgId={orgId} onChanged={load} />
            </div>
          </div>

          <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5 space-y-4">
            <p className="text-[var(--inaya-text-primary)] font-bold text-sm">Backup Policies</p>
            {policies.length === 0 ? (
              <EmptyState compact icon="🗂️" description="No backup policies yet." />
            ) : (
              <div className="space-y-1.5">{policies.map((p) => <PolicyRow key={p._id} orgId={orgId} policy={p} onChanged={load} />)}</div>
            )}
            <form onSubmit={createPolicy} className="border-t border-white/5 pt-4 flex flex-wrap items-center gap-2">
              <input placeholder="Policy name" value={policyName} onChange={(e) => setPolicyName(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
              <input placeholder="tag selector, e.g. env=prod" value={policySelector} onChange={(e) => setPolicySelector(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
              <button type="submit" disabled={policyBusy || !policyName.trim()} className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg disabled:opacity-40">
                {policyBusy ? "Creating…" : "Create Policy"}
              </button>
            </form>
          </div>
        </>
      )}
    </div>
  );
}
