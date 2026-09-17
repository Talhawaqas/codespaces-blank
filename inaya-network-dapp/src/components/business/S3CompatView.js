"use client";

// src/components/business/S3CompatView.js
//
// Multi-Cloud Enterprise Storage Compatibility SOW — create/revoke
// S3/Azure-compatible credentials for this org, entirely inside Business
// Workspace. Same self-contained-view pattern as ApiKeysView.js. The raw
// secretAccessKey is shown exactly once, right after creation, never again.

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../EmptyState";
import ConfirmButton from "./ConfirmButton";

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

export default function S3CompatView({ orgId }) {
  const [creds, setCreds] = useState(null);
  const [error, setError] = useState("");
  const [label, setLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [justCreated, setJustCreated] = useState(null);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [scopeBucket, setScopeBucket] = useState("");
  const [scopePrefix, setScopePrefix] = useState("");
  const [scopeOps, setScopeOps] = useState([]);
  const [scopeExpiry, setScopeExpiry] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await api(`/api/orgs/s3-compat/credentials?orgId=${orgId}`);
      setCreds(data.credentials);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  function toggleOp(op) {
    setScopeOps((prev) => (prev.includes(op) ? prev.filter((o) => o !== op) : [...prev, op]));
  }

  async function create(e) {
    e.preventDefault();
    setCreating(true);
    setError("");
    try {
      // Granular Storage Access Grants (SOW §2) -- scope is entirely
      // optional; omitting every field issues the same unrestricted
      // owner-level credential Workstream A always has.
      const scope =
        scopeOpen && (scopeBucket || scopeExpiry || scopeOps.length > 0)
          ? {
              ...(scopeBucket ? { bucket: scopeBucket.trim() } : {}),
              ...(scopeBucket && scopePrefix ? { prefix: scopePrefix.trim() } : {}),
              ...(scopeOps.length > 0 ? { operations: scopeOps } : {}),
              ...(scopeExpiry ? { expiresAt: new Date(scopeExpiry).toISOString() } : {}),
            }
          : undefined;
      const result = await api("/api/orgs/s3-compat/credentials", { method: "POST", body: JSON.stringify({ orgId, label: label.trim() || undefined, scope }) });
      setJustCreated(result);
      setLabel("");
      setScopeOpen(false);
      setScopeBucket("");
      setScopePrefix("");
      setScopeOps([]);
      setScopeExpiry("");
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  }

  async function revoke(accessKeyId) {
    try {
      await api(`/api/orgs/s3-compat/credentials/${accessKeyId}`, { method: "DELETE", body: JSON.stringify({ orgId }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  const endpointUrl = typeof window !== "undefined" ? `${window.location.origin}/api/s3` : "/api/s3";

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-[var(--inaya-text-primary)] font-bold text-sm">S3-Compatible Storage</h3>
        <p className="text-[var(--inaya-text-muted)] text-xs mt-0.5 max-w-xl">
          Consume this org&apos;s Business Workspace storage from any AWS S3-compatible tool — the AWS CLI, an SDK,
          rclone — without ever leaving Business Workspace or connecting a wallet. The same endpoint and credential
          also accept Google Cloud Storage&apos;s XML API signing conventions (both its AWS4-HMAC-SHA256
          interoperability mode and its native GOOG4-HMAC-SHA256 scheme) — one credential, no separate Google setup.
          Objects written this way are still encrypted, sharded, and redundantly pinned exactly like every other
          Inaya document, using a server-managed encryption key scoped to this org (not the zero-knowledge,
          browser-only key model the rest of Business Workspace uses — see the SOW report for why that distinction
          is necessary for protocol compatibility, and how the key is protected).
        </p>
      </div>

      <div className="bg-black/20 border border-white/5 rounded-lg p-3">
        <p className="text-[var(--inaya-text-muted)] text-[11px] font-bold uppercase mb-1">Endpoint (AWS S3 &amp; Google Cloud Storage)</p>
        <code className="text-[12px] text-[var(--inaya-text-primary)] break-all">{endpointUrl}</code>
      </div>

      {error && <p className="text-red-400 text-xs">{error}</p>}

      {justCreated && (
        <div className="rounded-2xl p-4 border bg-emerald-400/10 border-emerald-400/30 space-y-2">
          <p className="text-emerald-400 text-xs font-bold uppercase">Save these now — the secret won&apos;t be shown again</p>
          <div>
            <p className="text-[var(--inaya-text-muted)] text-[11px]">Access Key ID</p>
            <code className="block bg-black/40 rounded-lg p-2.5 text-[12px] text-[var(--inaya-text-primary)] break-all">{justCreated.accessKeyId}</code>
          </div>
          <div>
            <p className="text-[var(--inaya-text-muted)] text-[11px]">Secret Access Key</p>
            <code className="block bg-black/40 rounded-lg p-2.5 text-[12px] text-[var(--inaya-text-primary)] break-all">{justCreated.secretAccessKey}</code>
          </div>
          <button onClick={() => setJustCreated(null)} className="text-[11px] text-[var(--inaya-text-muted)] underline">Dismiss</button>
        </div>
      )}

      <InayaDrivePanel endpointUrl={endpointUrl} prefill={justCreated} />

      <form onSubmit={create} className="space-y-2">
        <div className="flex gap-2 flex-wrap">
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (optional)" className="flex-1 min-w-[200px] bg-black/45 border border-white/15 rounded-xl px-3.5 py-2 text-sm text-[var(--inaya-text-primary)]" />
          <button type="button" onClick={() => setScopeOpen((v) => !v)} className="text-[11px] font-bold px-3 py-2 rounded-xl bg-white/5 text-[var(--inaya-text-muted)]">
            {scopeOpen ? "Hide scope ▲" : "Restrict scope (optional) ▼"}
          </button>
          <button type="submit" disabled={creating} className="text-xs font-bold px-3.5 py-2 rounded-xl bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40">
            {creating ? "Creating…" : "+ New S3 credential"}
          </button>
        </div>
        {scopeOpen && (
          <div className="bg-black/20 border border-white/5 rounded-lg p-3 space-y-2">
            <p className="text-[var(--inaya-text-muted)] text-[11px]">
              Leave fields blank for an unrestricted, owner-level credential. Anything set here is enforced
              server-side on every request — a scoped credential can never read/write outside its own grant.
            </p>
            <div className="flex gap-2 flex-wrap">
              <input value={scopeBucket} onChange={(e) => setScopeBucket(e.target.value)} placeholder="Bucket (e.g. finance)" className="flex-1 min-w-[160px] bg-black/45 border border-white/15 rounded-lg px-3 py-1.5 text-xs text-[var(--inaya-text-primary)]" />
              <input value={scopePrefix} onChange={(e) => setScopePrefix(e.target.value)} disabled={!scopeBucket} placeholder="Prefix (e.g. invoices/2026/)" className="flex-1 min-w-[160px] bg-black/45 border border-white/15 rounded-lg px-3 py-1.5 text-xs text-[var(--inaya-text-primary)] disabled:opacity-40" />
              <input type="date" value={scopeExpiry} onChange={(e) => setScopeExpiry(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-3 py-1.5 text-xs text-[var(--inaya-text-primary)]" />
            </div>
            <div className="flex gap-1.5 flex-wrap">
              {["READ", "WRITE", "DELETE", "LIST"].map((op) => (
                <button key={op} type="button" onClick={() => toggleOp(op)} className={`text-[10px] font-bold uppercase px-2.5 py-1 rounded-md ${scopeOps.includes(op) ? "bg-[#00f2fe]/20 text-[#00f2fe]" : "bg-white/5 text-[var(--inaya-text-muted)]"}`}>
                  {op}
                </button>
              ))}
            </div>
          </div>
        )}
      </form>

      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!creds ? (
          <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>
        ) : creds.length === 0 ? (
          <EmptyState compact icon="☁️" description="No S3-compatible credentials yet." />
        ) : (
          <div className="space-y-2">
            {creds.map((c) => (
              <div key={c.accessKeyId} className="bg-black/20 border border-white/5 rounded-lg p-3 flex items-center justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <p className="text-[var(--inaya-text-primary)] text-sm">{c.label || c.accessKeyId}</p>
                  <p className="text-[var(--inaya-text-muted)] text-[12px] font-mono mt-0.5">
                    {c.accessKeyId} · {new Date(c.createdAt).toLocaleDateString()} {c.revokedAt && `· revoked`}
                  </p>
                  {c.scope && (
                    <p className="text-[10px] text-[#00f2fe] mt-1">
                      Scoped{c.scope.bucket ? ` · bucket=${c.scope.bucket}` : ""}{c.scope.prefix ? ` · prefix=${c.scope.prefix}` : ""}
                      {c.scope.operations ? ` · ${c.scope.operations.join("/")}` : ""}{c.scope.expiresAt ? ` · expires ${new Date(c.scope.expiresAt).toLocaleDateString()}` : ""}
                    </p>
                  )}
                </div>
                {!c.revokedAt && (
                  <ConfirmButton onConfirm={() => revoke(c.accessKeyId)} className="text-[11px] font-bold uppercase px-2.5 py-1.5 rounded-md bg-white/5 text-[var(--inaya-text-muted)] shrink-0">
                    Revoke
                  </ConfirmButton>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <BucketsPanel orgId={orgId} />
    </div>
  );
}

/** Inaya Drive (SOW §8) -- mounts this org's S3-compatible storage as a
 *  real Windows drive letter. Only rendered/functional inside the Tauri
 *  desktop app (window.__TAURI__ present); invisible in an ordinary
 *  browser tab, since there's no OS-level filesystem to mount into there.
 *  Calls the real inaya-drive-helper.exe child process via Tauri commands
 *  (see inaya-desktop/src-tauri/src/lib.rs's mount_inaya_drive/
 *  unmount_inaya_drive) -- that process is a standalone WinFSP-backed
 *  filesystem talking to the exact same /api/s3 endpoint any AWS CLI
 *  session already uses, authenticated with a real, normal S3 credential
 *  (optionally one scoped via Granular Storage Access Grants above, e.g.
 *  a read-only drive limited to one bucket). */
function InayaDrivePanel({ endpointUrl, prefill }) {
  const [isTauri, setIsTauri] = useState(false);
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [drive, setDrive] = useState("I:");
  const [status, setStatus] = useState("");
  const [mounted, setMounted] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setIsTauri(typeof window !== "undefined" && !!window.__TAURI__);
  }, []);

  useEffect(() => {
    if (prefill) {
      setAccessKeyId(prefill.accessKeyId || "");
      setSecretAccessKey(prefill.secretAccessKey || "");
    }
  }, [prefill]);

  if (!isTauri) return null;

  async function mount() {
    setBusy(true);
    setStatus("");
    try {
      const result = await window.__TAURI__.core.invoke("mount_inaya_drive", { endpoint: endpointUrl, accessKeyId, secretAccessKey, drive });
      setStatus(result);
      setMounted(true);
    } catch (err) {
      setStatus(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function unmount() {
    setBusy(true);
    try {
      await window.__TAURI__.core.invoke("unmount_inaya_drive");
      setStatus(`Unmounted ${drive}`);
      setMounted(false);
    } catch (err) {
      setStatus(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-black/20 border border-white/5 rounded-lg p-3 space-y-2">
      <p className="text-[var(--inaya-text-primary)] font-bold text-xs uppercase">Inaya Drive</p>
      <p className="text-[var(--inaya-text-muted)] text-[11px] max-w-xl">
        Mount this org&apos;s storage as a real drive letter in File Explorer — browse, open, and save files
        directly, no upload/download step. Backed by the same S3-compatible endpoint and credential above.
      </p>
      <div className="flex gap-2 flex-wrap">
        <input value={accessKeyId} onChange={(e) => setAccessKeyId(e.target.value)} placeholder="Access Key ID" disabled={mounted} className="flex-1 min-w-[160px] bg-black/45 border border-white/15 rounded-lg px-3 py-1.5 text-xs text-[var(--inaya-text-primary)] disabled:opacity-40" />
        <input value={secretAccessKey} onChange={(e) => setSecretAccessKey(e.target.value)} placeholder="Secret Access Key" disabled={mounted} className="flex-1 min-w-[160px] bg-black/45 border border-white/15 rounded-lg px-3 py-1.5 text-xs text-[var(--inaya-text-primary)] disabled:opacity-40" />
        <input value={drive} onChange={(e) => setDrive(e.target.value)} placeholder="I:" disabled={mounted} className="w-16 bg-black/45 border border-white/15 rounded-lg px-3 py-1.5 text-xs text-[var(--inaya-text-primary)] disabled:opacity-40" />
        {!mounted ? (
          <button onClick={mount} disabled={busy || !accessKeyId || !secretAccessKey} className="text-[11px] font-bold uppercase px-3 py-1.5 rounded-lg bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40">
            {busy ? "Mounting…" : "Mount"}
          </button>
        ) : (
          <button onClick={unmount} disabled={busy} className="text-[11px] font-bold uppercase px-3 py-1.5 rounded-lg bg-white/5 text-[var(--inaya-text-muted)] disabled:opacity-40">
            {busy ? "Unmounting…" : "Unmount"}
          </button>
        )}
      </div>
      {status && <p className="text-[11px] text-[var(--inaya-text-muted)]">{status}</p>}
    </div>
  );
}

/** Enterprise Storage Console (SOW §10) -- Business Workspace's real,
 *  data-backed view of the capabilities the Storj-Inspired Storage
 *  Capability Expansion SOW added: bucket versioning, Object Lock,
 *  version history + restore, Legal Hold, Lifecycle policies, and
 *  storage health -- every field here reads live from the real
 *  org_documents/backupEngine state via manage/route.js, nothing
 *  synthetic. */
function BucketsPanel({ orgId }) {
  const [buckets, setBuckets] = useState(null);
  const [openBucket, setOpenBucket] = useState(null);
  const [objects, setObjects] = useState(null);
  const [openKey, setOpenKey] = useState(null);
  const [versions, setVersions] = useState(null);
  const [health, setHealth] = useState({});
  const [lifecycle, setLifecycle] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const loadBuckets = useCallback(async () => {
    try {
      const data = await api(`/api/orgs/s3-compat/manage?orgId=${orgId}&action=buckets`);
      setBuckets(data.buckets);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { loadBuckets(); }, [loadBuckets]);

  async function openBucketPanel(name) {
    if (openBucket === name) { setOpenBucket(null); return; }
    setOpenBucket(name);
    setOpenKey(null);
    setObjects(null);
    setLifecycle(null);
    try {
      const [objData, lcData] = await Promise.all([
        api(`/api/orgs/s3-compat/manage?orgId=${orgId}&action=objects&bucket=${encodeURIComponent(name)}`),
        api(`/api/orgs/s3-compat/manage?orgId=${orgId}&action=lifecycle&bucket=${encodeURIComponent(name)}`),
      ]);
      setObjects(objData.contents);
      setLifecycle(lcData.policy);
    } catch (err) {
      setError(err.message);
    }
  }

  async function toggleVersioning(bucket, current) {
    setBusy(true);
    try {
      const next = current === "Enabled" ? "Suspended" : "Enabled";
      await api("/api/orgs/s3-compat/manage", { method: "POST", body: JSON.stringify({ orgId, action: "versioning", bucket, status: next }) });
      await loadBuckets();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function enableLock(bucket) {
    setBusy(true);
    try {
      await api("/api/orgs/s3-compat/manage", { method: "POST", body: JSON.stringify({ orgId, action: "object-lock", bucket }) });
      await loadBuckets();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function openVersions(bucket, key) {
    if (openKey === key) { setOpenKey(null); setVersions(null); return; }
    setOpenKey(key);
    try {
      const data = await api(`/api/orgs/s3-compat/manage?orgId=${orgId}&action=versions&bucket=${encodeURIComponent(bucket)}&key=${encodeURIComponent(key)}`);
      setVersions(data.versions);
      const h = await api(`/api/orgs/s3-compat/manage?orgId=${orgId}&action=health&bucket=${encodeURIComponent(bucket)}&key=${encodeURIComponent(key)}`);
      setHealth((prev) => ({ ...prev, [key]: h.health }));
    } catch (err) { setError(err.message); }
  }

  async function restore(bucket, key, versionId) {
    setBusy(true);
    try {
      await api("/api/orgs/s3-compat/manage", { method: "POST", body: JSON.stringify({ orgId, action: "restore", bucket, key, versionId }) });
      await openBucketPanel(bucket);
      setOpenKey(null);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function setLegalHold(bucket, key, versionId, legalHold) {
    setBusy(true);
    try {
      await api("/api/orgs/s3-compat/manage", { method: "POST", body: JSON.stringify({ orgId, action: "legal-hold", bucket, key, versionId, legalHold }) });
      await openVersions(bucket, key); // toggles closed then re-opens fresh below
      await openVersions(bucket, key);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function setRetention(bucket, key, versionId) {
    const days = window.prompt("Retain for how many days (GOVERNANCE mode)?", "30");
    if (!days || Number(days) <= 0) return;
    setBusy(true);
    try {
      const retentionUntil = new Date(Date.now() + Number(days) * 24 * 60 * 60 * 1000).toISOString();
      await api("/api/orgs/s3-compat/manage", { method: "POST", body: JSON.stringify({ orgId, action: "retention", bucket, key, versionId, retentionMode: "GOVERNANCE", retentionUntil }) });
      await openVersions(bucket, key);
      await openVersions(bucket, key);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function saveLifecycle(bucket, days) {
    setBusy(true);
    try {
      const rules = days ? [{ id: "default", prefix: "", expirationDays: Number(days) }] : [];
      const result = days
        ? await api("/api/orgs/s3-compat/manage", { method: "POST", body: JSON.stringify({ orgId, action: "lifecycle", bucket, rules }) })
        : await api("/api/orgs/s3-compat/manage", { method: "POST", body: JSON.stringify({ orgId, action: "lifecycle-delete", bucket }) });
      setLifecycle(days ? result : null);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function runLifecycleNow() {
    setBusy(true);
    try {
      const result = await api("/api/orgs/s3-compat/manage", { method: "POST", body: JSON.stringify({ orgId, action: "lifecycle-run" }) });
      window.alert(`Lifecycle enforcement: scanned ${result.scanned}, expired ${result.expired}, skipped (locked/held) ${result.skippedLocked}.`);
      if (openBucket) openBucketPanel(openBucket);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  if (!buckets) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-[var(--inaya-text-primary)] font-bold text-xs uppercase">Buckets, Versions & Object Protection</h4>
        <button onClick={runLifecycleNow} disabled={busy} className="text-[10px] font-bold uppercase px-2.5 py-1.5 rounded-md bg-white/5 text-[var(--inaya-text-muted)] disabled:opacity-40">
          Run lifecycle enforcement now
        </button>
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      {buckets.length === 0 ? (
        <EmptyState compact icon="🗂️" description="No buckets yet — created automatically on first upload via S3/Azure." />
      ) : (
        <div className="space-y-2">
          {buckets.map((b) => (
            <div key={b.name} className="bg-black/20 border border-white/5 rounded-lg p-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <button onClick={() => openBucketPanel(b.name)} className="text-[var(--inaya-text-primary)] text-sm font-bold">{b.name}</button>
                <div className="flex gap-1.5 items-center flex-wrap">
                  <span className="text-[10px] px-2 py-1 rounded-md bg-white/5 text-[var(--inaya-text-muted)]">Versioning: {b.versioningStatus}</span>
                  {b.objectLockEnabled && <span className="text-[10px] px-2 py-1 rounded-md bg-amber-400/10 text-amber-400">Object Lock ON</span>}
                  <button disabled={busy} onClick={() => toggleVersioning(b.name, b.versioningStatus)} className="text-[10px] font-bold uppercase px-2 py-1 rounded-md bg-white/5 text-[var(--inaya-text-muted)] disabled:opacity-40">
                    {b.versioningStatus === "Enabled" ? "Suspend" : "Enable"} versioning
                  </button>
                  {b.versioningStatus === "Enabled" && !b.objectLockEnabled && (
                    <button disabled={busy} onClick={() => enableLock(b.name)} className="text-[10px] font-bold uppercase px-2 py-1 rounded-md bg-white/5 text-[var(--inaya-text-muted)] disabled:opacity-40">
                      Enable Object Lock
                    </button>
                  )}
                </div>
              </div>

              {openBucket === b.name && (
                <div className="mt-3 space-y-2 border-t border-white/5 pt-3">
                  <div className="flex items-center gap-2 text-[11px] text-[var(--inaya-text-muted)]">
                    <span>Lifecycle: expire after</span>
                    <input
                      type="number" min="1" placeholder="days"
                      defaultValue={lifecycle?.rules?.[0]?.expirationDays || ""}
                      onBlur={(e) => saveLifecycle(b.name, e.target.value)}
                      className="w-20 bg-black/45 border border-white/15 rounded-md px-2 py-1 text-[11px] text-[var(--inaya-text-primary)]"
                    />
                    <span>days (blank = no policy)</span>
                  </div>

                  {!objects ? (
                    <p className="text-[var(--inaya-text-muted)] text-xs">Loading objects…</p>
                  ) : objects.length === 0 ? (
                    <p className="text-[var(--inaya-text-muted)] text-xs">No objects in this bucket.</p>
                  ) : (
                    objects.map((obj) => (
                      <div key={obj.filename} className="bg-black/30 rounded-md p-2.5">
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <button onClick={() => openVersions(b.name, obj.filename)} className="text-[12px] text-[var(--inaya-text-primary)] font-mono">{obj.filename}</button>
                          <span className="text-[10px] text-[var(--inaya-text-muted)]">{obj.sizeBytes} bytes</span>
                        </div>
                        {openKey === obj.filename && versions && (
                          <div className="mt-2 space-y-1.5">
                            {health[obj.filename] && (
                              <p className="text-[10px] text-[var(--inaya-text-muted)]">
                                Health: <span className={health[obj.filename].healthState === "PROTECTED" ? "text-emerald-400" : "text-amber-400"}>{health[obj.filename].healthState}</span>
                                {" · "}alpha replicas {health[obj.filename].shardAlpha.replicaCount}/{health[obj.filename].shardAlpha.targetReplicaCount}
                                {" · "}beta replicas {health[obj.filename].shardBeta.replicaCount}/{health[obj.filename].shardBeta.targetReplicaCount}
                              </p>
                            )}
                            {versions.map((v) => (
                              <div key={v.versionId} className="flex items-center justify-between gap-2 flex-wrap bg-black/30 rounded p-2">
                                <div className="text-[10px] text-[var(--inaya-text-muted)] font-mono">
                                  {v.versionId} {v.isLatest && <span className="text-[#00f2fe]">· latest</span>} {v.deleteMarker && <span className="text-red-400">· deleted</span>}
                                  {v.legalHold && <span className="text-amber-400"> · legal hold</span>}
                                  {v.retentionUntil && <span className="text-amber-400"> · locked until {new Date(v.retentionUntil).toLocaleDateString()}</span>}
                                </div>
                                <div className="flex gap-1.5">
                                  {!v.isLatest && !v.deleteMarker && (
                                    <button disabled={busy} onClick={() => restore(b.name, obj.filename, v.versionId)} className="text-[10px] font-bold uppercase px-2 py-1 rounded-md bg-white/5 text-[var(--inaya-text-muted)]">Restore</button>
                                  )}
                                  <button disabled={busy} onClick={() => setLegalHold(b.name, obj.filename, v.versionId, !v.legalHold)} className="text-[10px] font-bold uppercase px-2 py-1 rounded-md bg-white/5 text-[var(--inaya-text-muted)]">
                                    {v.legalHold ? "Release hold" : "Legal hold"}
                                  </button>
                                  {b.objectLockEnabled && (
                                    <button disabled={busy} onClick={() => setRetention(b.name, obj.filename, v.versionId)} className="text-[10px] font-bold uppercase px-2 py-1 rounded-md bg-white/5 text-[var(--inaya-text-muted)]">Lock</button>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
