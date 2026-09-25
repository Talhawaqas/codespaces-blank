"use client";

// src/components/business/NasManagementView.js
//
// Sovereign NAS SOW, Workstream T (NAS Management Console). This pass
// covers the functional core -- Overview/Appliances/Shares/Users/Backup/
// Recovery -- rather than every one of the SOW's 18 illustrative
// sections; Security/Hardware Health/Twin/Updates panels are the
// documented next-pass polish (see docs/sovereign-nas-report.md). Same
// self-contained-view pattern as DataSourcesView.js: a local api() fetch
// wrapper, real calls against real API routes, no client-side simulation.

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../EmptyState";

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

const HEALTH_STYLES = {
  REACHABLE: "bg-emerald-400/10 text-emerald-400 border-emerald-400/30",
  DEGRADED: "bg-amber-400/10 text-amber-400 border-amber-400/30",
  UNREACHABLE: "bg-red-400/10 text-red-400 border-red-400/30",
  UNKNOWN: "border-white/10 text-[var(--inaya-text-muted)]",
};

function RegisterApplianceForm({ orgId, onChanged }) {
  const [name, setName] = useState("");
  const [backend, setBackend] = useState("wsl-local");
  const [host, setHost] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/orgs/nas/appliances", { method: "POST", body: JSON.stringify({ orgId, name: name.trim(), backend, host: host.trim() }) });
      setName("");
      setHost("");
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="rounded-lg border border-white/10 p-4 space-y-3">
      <div className="text-sm font-semibold">Register a NAS appliance</div>
      <input type="text" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required
        className="w-full rounded border border-white/10 bg-transparent px-3 py-2 text-sm" />
      <select value={backend} onChange={(e) => setBackend(e.target.value)} className="w-full rounded border border-white/10 bg-transparent px-3 py-2 text-sm">
        <option value="wsl-local">wsl-local (this dev/test appliance profile — Samba + NFS on WSL2)</option>
      </select>
      <input type="text" placeholder="Host / IP (e.g. 172.21.35.48)" value={host} onChange={(e) => setHost(e.target.value)} required
        className="w-full rounded border border-white/10 bg-transparent px-3 py-2 text-sm" />
      {error && <div className="text-sm text-red-400">{error}</div>}
      <button type="submit" disabled={busy} className="rounded bg-[var(--inaya-accent)] px-4 py-2 text-sm font-medium disabled:opacity-50">
        {busy ? "Registering…" : "Register & Check Health"}
      </button>
      <p className="text-xs text-[var(--inaya-text-muted)]">
        Only the wsl-local backend is real and tested this pass. A production physical/VM appliance would run its
        own agent daemon instead — see the completion report for exactly what that would take.
      </p>
    </form>
  );
}

function CreateShareForm({ orgId, applianceId, onChanged }) {
  const [shareName, setShareName] = useState("");
  const [ownerUnixUser, setOwnerUnixUser] = useState("");
  const [quotaGB, setQuotaGB] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/orgs/nas/shares", {
        method: "POST",
        body: JSON.stringify({
          orgId, applianceId, shareName: shareName.trim(), ownerUnixUser: ownerUnixUser.trim(),
          quotaBytes: quotaGB ? Number(quotaGB) * 1024 * 1024 * 1024 : undefined,
        }),
      });
      setShareName("");
      setOwnerUnixUser("");
      setQuotaGB("");
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2 rounded border border-white/10 p-3">
      <div className="flex flex-col gap-1">
        <label className="text-xs text-[var(--inaya-text-muted)]">Share name</label>
        <input type="text" value={shareName} onChange={(e) => setShareName(e.target.value)} required className="rounded border border-white/10 bg-transparent px-2 py-1 text-sm" />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs text-[var(--inaya-text-muted)]">Owner NAS username</label>
        <input type="text" value={ownerUnixUser} onChange={(e) => setOwnerUnixUser(e.target.value)} required className="rounded border border-white/10 bg-transparent px-2 py-1 text-sm" placeholder="nasjdoe" />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs text-[var(--inaya-text-muted)]">Quota (GB, policy only — see note)</label>
        <input type="number" value={quotaGB} onChange={(e) => setQuotaGB(e.target.value)} className="w-24 rounded border border-white/10 bg-transparent px-2 py-1 text-sm" />
      </div>
      <button type="submit" disabled={busy} className="rounded bg-[var(--inaya-accent)] px-3 py-1.5 text-sm font-medium disabled:opacity-50">
        {busy ? "Creating…" : "Create real share"}
      </button>
      {error && <div className="w-full text-sm text-red-400">{error}</div>}
    </form>
  );
}

function ProvisionUserForm({ orgId, applianceId, onChanged }) {
  const [memberEmail, setMemberEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [issuedPassword, setIssuedPassword] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setIssuedPassword(null);
    try {
      const result = await api("/api/orgs/nas/users", { method: "POST", body: JSON.stringify({ orgId, applianceId, memberEmail: memberEmail.trim() }) });
      setIssuedPassword({ email: memberEmail.trim(), password: result.initialPassword, unixUsername: result.nasUser.unixUsername });
      setMemberEmail("");
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2 rounded border border-white/10 p-3">
      <div className="flex flex-col gap-1">
        <label className="text-xs text-[var(--inaya-text-muted)]">Org member email (must already have NAS access)</label>
        <input type="email" value={memberEmail} onChange={(e) => setMemberEmail(e.target.value)} required className="rounded border border-white/10 bg-transparent px-2 py-1 text-sm" />
      </div>
      <button type="submit" disabled={busy} className="rounded bg-[var(--inaya-accent)] px-3 py-1.5 text-sm font-medium disabled:opacity-50">
        {busy ? "Provisioning…" : "Grant NAS login"}
      </button>
      {error && <div className="w-full text-sm text-red-400">{error}</div>}
      {issuedPassword && (
        <div className="w-full rounded border border-amber-400/30 bg-amber-400/10 p-2 text-xs text-amber-200">
          One-time password for <strong>{issuedPassword.unixUsername}</strong> ({issuedPassword.email}) — shown once, relay it securely:{" "}
          <code className="font-mono">{issuedPassword.password}</code>
        </div>
      )}
    </form>
  );
}

function ShareRow({ orgId, share, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [lastRun, setLastRun] = useState(null);
  const [recycleEntries, setRecycleEntries] = useState(null);

  async function runBackup() {
    setBusy(true);
    setError("");
    try {
      const result = await api(`/api/orgs/nas/shares/${share._id}/backup`, { method: "POST", body: JSON.stringify({ orgId }) });
      setLastRun(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function viewRecycleBin() {
    setBusy(true);
    setError("");
    try {
      const result = await api(`/api/orgs/nas/shares/${share._id}/recycle-bin?orgId=${orgId}`);
      setRecycleEntries(result.entries);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError("");
    try {
      await api(`/api/orgs/nas/shares/${share._id}?orgId=${orgId}`, { method: "DELETE" });
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded border border-white/10 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium">{share.shareName}</div>
          <div className="text-xs text-[var(--inaya-text-muted)]">{share.dataPath} — owner: {share.ownerUnixUser} — recycle bin: {share.recycleBinEnabled ? "on" : "off"}</div>
          {share.quota && <div className="text-xs text-amber-300">Quota policy: {(share.quota.requestedBytes / 1e9).toFixed(1)} GB requested — NOT enforced (WSL2 ext4 has no quota mount option in this environment)</div>}
        </div>
        <div className="flex gap-2">
          <button onClick={runBackup} disabled={busy} className="rounded border border-white/10 px-2 py-1 text-xs">Backup to Inaya</button>
          <button onClick={viewRecycleBin} disabled={busy} className="rounded border border-white/10 px-2 py-1 text-xs">Recycle bin</button>
          <button onClick={remove} disabled={busy} className="rounded border border-red-400/30 px-2 py-1 text-xs text-red-400">Delete</button>
        </div>
      </div>
      {error && <div className="text-xs text-red-400">{error}</div>}
      {lastRun && <div className="text-xs text-[var(--inaya-text-muted)]">Backup run {lastRun.status}: {lastRun.filesBackedUp}/{lastRun.filesTotal} files backed up{lastRun.filesFailed ? `, ${lastRun.filesFailed} failed` : ""}.</div>}
      {recycleEntries && (
        <div className="text-xs text-[var(--inaya-text-muted)]">
          {recycleEntries.length === 0 ? "Recycle bin is empty." : recycleEntries.map((e) => <div key={e.path}>{e.path} ({e.sizeBytes}B, deleted {e.deletedAt})</div>)}
        </div>
      )}
    </div>
  );
}

function ApplianceCard({ orgId, appliance, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [shares, setShares] = useState([]);
  const [showCreateShare, setShowCreateShare] = useState(false);
  const [showProvisionUser, setShowProvisionUser] = useState(false);

  const loadShares = useCallback(async () => {
    try {
      const result = await api(`/api/orgs/nas/shares?orgId=${orgId}&applianceId=${appliance._id}`);
      setShares(result.shares);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId, appliance._id]);

  useEffect(() => { loadShares(); }, [loadShares]);

  async function recheckHealth() {
    setBusy(true);
    setError("");
    try {
      await api(`/api/orgs/nas/appliances/${appliance._id}/health`, { method: "POST", body: JSON.stringify({ orgId }) });
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-white/10 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold">{appliance.name}</div>
          <div className="text-xs text-[var(--inaya-text-muted)]">{appliance.backend} · {appliance.host}</div>
        </div>
        <div className="flex items-center gap-2">
          <span className={`rounded-full border px-2 py-0.5 text-xs ${HEALTH_STYLES[appliance.status] || HEALTH_STYLES.UNKNOWN}`}>{appliance.status}</span>
          <button onClick={recheckHealth} disabled={busy} className="rounded border border-white/10 px-2 py-1 text-xs">Recheck</button>
        </div>
      </div>
      {error && <div className="text-xs text-red-400">{error}</div>}
      {appliance.lastHealthDetail && (
        <div className="text-xs text-[var(--inaya-text-muted)]">
          SMB: {appliance.lastHealthDetail.smb.reachable ? "reachable" : "unreachable"} (service {appliance.lastHealthDetail.smb.serviceActive ? "active" : "inactive"}) ·
          NFS: {appliance.lastHealthDetail.nfs.reachable ? "reachable" : "unreachable"} (service {appliance.lastHealthDetail.nfs.serviceActive ? "active" : "inactive"})
        </div>
      )}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-xs font-semibold uppercase tracking-wide text-[var(--inaya-text-muted)]">Shares ({shares.length})</div>
          <div className="flex gap-2">
            <button onClick={() => setShowProvisionUser((v) => !v)} className="text-xs underline">{showProvisionUser ? "Hide" : "Grant NAS login"}</button>
            <button onClick={() => setShowCreateShare((v) => !v)} className="text-xs underline">{showCreateShare ? "Hide" : "New share"}</button>
          </div>
        </div>
        {showProvisionUser && <ProvisionUserForm orgId={orgId} applianceId={appliance._id} onChanged={() => setShowProvisionUser(false)} />}
        {showCreateShare && <CreateShareForm orgId={orgId} applianceId={appliance._id} onChanged={() => { setShowCreateShare(false); loadShares(); }} />}
        {shares.map((s) => <ShareRow key={s._id} orgId={orgId} share={s} onChanged={loadShares} />)}
      </div>
    </div>
  );
}

export default function NasManagementView({ orgId }) {
  const [appliances, setAppliances] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const result = await api(`/api/orgs/nas/appliances?orgId=${orgId}`);
      setAppliances(result.appliances);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  if (appliances === null) return <div className="text-sm text-[var(--inaya-text-muted)]">Loading…</div>;

  return (
    <div className="space-y-6">
      <RegisterApplianceForm orgId={orgId} onChanged={load} />
      {error && <div className="text-sm text-red-400">{error}</div>}
      {appliances.length === 0 ? (
        <EmptyState title="No NAS appliances registered" description="Register your first appliance above to start creating real SMB/NFS shares." />
      ) : (
        <div className="space-y-4">
          {appliances.map((a) => <ApplianceCard key={a._id} orgId={orgId} appliance={a} onChanged={load} />)}
        </div>
      )}
    </div>
  );
}
