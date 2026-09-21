"use client";

// src/components/business/CloudBackupSchedulerView.js
//
// Modular Enterprise Adoption Features SOW, Feature 3 — Smart Cloud
// Backup & Health Scheduler. Same self-contained-view pattern as
// WhatIfStudioView.js / DataRoomsView.js: credential management, schedule
// CRUD, a per-schedule health badge, manual "Run now", and expandable run
// history — all thin, real calls against cloudBackupScheduler.js's API
// routes, no client-side simulation of what a run did.

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../EmptyState";

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

const PROVIDER_LABELS = { aws: "AWS S3", azure: "Azure Blob", gcs: "Google Cloud Storage" };

const PROVIDER_FIELDS = {
  aws: [
    { key: "accessKeyId", label: "Access Key ID" },
    { key: "secretAccessKey", label: "Secret Access Key", secret: true },
    { key: "region", label: "Region" },
  ],
  azure: [
    { key: "accountName", label: "Storage Account Name" },
    { key: "accountKey", label: "Account Key", secret: true },
  ],
  gcs: [
    { key: "hmacAccessId", label: "HMAC Access ID" },
    { key: "hmacSecret", label: "HMAC Secret", secret: true },
  ],
};

const HEALTH_STYLES = {
  HEALTHY: "bg-emerald-400/10 text-emerald-400 border-emerald-400/30",
  WARNING: "bg-amber-400/10 text-amber-400 border-amber-400/30",
  DEGRADED: "bg-amber-400/10 text-amber-400 border-amber-400/30",
  FAILED: "bg-red-400/10 text-red-400 border-red-400/30",
  PAUSED: "border-white/10 text-[var(--inaya-text-muted)]",
  UNKNOWN: "border-white/10 text-[var(--inaya-text-muted)]",
};

const RUN_STATUS_STYLES = {
  SUCCESS: "bg-emerald-400/10 text-emerald-400 border-emerald-400/30",
  PARTIAL: "bg-amber-400/10 text-amber-400 border-amber-400/30",
  VERIFICATION_FAILED: "bg-amber-400/10 text-amber-400 border-amber-400/30",
  FAILED: "bg-red-400/10 text-red-400 border-red-400/30",
};

function CredentialsPanel({ orgId, credentials, onChanged }) {
  const [provider, setProvider] = useState("aws");
  const [label, setLabel] = useState("");
  const [fields, setFields] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function setField(key, value) {
    setFields((prev) => ({ ...prev, [key]: value }));
  }

  async function store(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/orgs/backup-credentials", { method: "POST", body: JSON.stringify({ orgId, provider, label: label.trim() || undefined, credentials: fields }) });
      setLabel("");
      setFields({});
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(credentialId) {
    setError("");
    try {
      await api(`/api/orgs/backup-credentials/${credentialId}`, { method: "DELETE", body: JSON.stringify({ orgId }) });
      onChanged();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5 space-y-4">
      <div>
        <p className="text-[var(--inaya-text-primary)] font-bold text-sm">Cloud Source Credentials</p>
        <p className="text-[var(--inaya-text-muted)] text-xs mt-0.5">
          Stored encrypted at rest under a key dedicated to this feature. Used only by a scheduled run itself — never returned to this or any other screen once saved.
        </p>
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}

      {credentials.length === 0 ? (
        <EmptyState compact icon="🔑" description="No cloud credentials stored yet." />
      ) : (
        <div className="space-y-1.5">
          {credentials.map((c) => (
            <div key={c.id} className="bg-black/20 border border-white/5 rounded-lg p-2.5 flex items-center justify-between gap-3">
              <div>
                <p className="text-[12px] text-[var(--inaya-text-primary)]">{c.label || PROVIDER_LABELS[c.provider]} <span className="text-[var(--inaya-text-muted)]">· {PROVIDER_LABELS[c.provider]}</span></p>
                <p className="text-[10px] text-[var(--inaya-text-muted)] font-mono">added by {c.createdByEmail} · {new Date(c.createdAt).toLocaleString()}</p>
              </div>
              <button onClick={() => revoke(c.id)} className="text-[10px] font-bold uppercase text-red-400 shrink-0">Revoke</button>
            </div>
          ))}
        </div>
      )}

      <form onSubmit={store} className="border-t border-white/5 pt-4 space-y-2">
        <p className="text-[var(--inaya-text-muted)] text-[11px] uppercase font-bold">Add a credential</p>
        <div className="flex flex-wrap items-center gap-2">
          <select value={provider} onChange={(e) => { setProvider(e.target.value); setFields({}); }} className="bg-black/30 border border-white/10 rounded-md text-xs px-2 py-1.5 text-[var(--inaya-text-primary)]">
            {Object.entries(PROVIDER_LABELS).map(([key, l]) => <option key={key} value={key}>{l}</option>)}
          </select>
          <input placeholder="Label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
          {PROVIDER_FIELDS[provider].map((f) => (
            <input key={f.key} type={f.secret ? "password" : "text"} placeholder={f.label} value={fields[f.key] || ""} onChange={(e) => setField(f.key, e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
          ))}
          <button type="submit" disabled={busy} className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg disabled:opacity-40">
            {busy ? "Saving…" : "Save Credential"}
          </button>
        </div>
      </form>
    </div>
  );
}

function RunHistory({ orgId, scheduleId }) {
  const [runs, setRuns] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      try {
        setRuns((await api(`/api/orgs/backup-schedules/${scheduleId}/runs?orgId=${orgId}`)).runs);
      } catch (err) {
        setError(err.message);
      }
    })();
  }, [orgId, scheduleId]);

  if (error) return <p className="text-red-400 text-[11px]">{error}</p>;
  if (!runs) return <p className="text-[var(--inaya-text-muted)] font-mono text-xs">Loading run history…</p>;
  if (runs.length === 0) return <p className="text-[var(--inaya-text-muted)] text-[11px]">No runs yet.</p>;

  return (
    <div className="space-y-1">
      {runs.map((r) => (
        <div key={r.id} className="bg-black/30 border border-white/10 rounded-md p-2 text-[11px] font-mono flex items-center justify-between gap-2">
          <span className="text-[var(--inaya-text-muted)]">{new Date(r.startedAt).toLocaleString()}</span>
          <span className="text-[var(--inaya-text-muted)]">seen {r.objectsSeen} · changed {r.objectsChanged} · copied {r.objectsCopied} · verified {r.objectsVerified}{r.verificationFailures > 0 ? ` · ${r.verificationFailures} failed verification` : ""}</span>
          <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded-full border shrink-0 ${RUN_STATUS_STYLES[r.status] || "border-white/10 text-[var(--inaya-text-muted)]"}`}>{r.status}</span>
        </div>
      ))}
    </div>
  );
}

function ScheduleRow({ orgId, schedule, onChanged }) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [runResult, setRunResult] = useState(null);

  async function act(action) {
    setBusy(true);
    setError("");
    try {
      await api(`/api/orgs/backup-schedules/${schedule.id}`, { method: "PATCH", body: JSON.stringify({ orgId, action }) });
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function runNow() {
    setBusy(true);
    setError("");
    setRunResult(null);
    try {
      const { run } = await api(`/api/orgs/backup-schedules/${schedule.id}/run`, { method: "POST", body: JSON.stringify({ orgId }) });
      setRunResult(run);
      setExpanded(true);
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-black/20 border border-white/5 rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-[13px] text-[var(--inaya-text-primary)] font-bold truncate">{schedule.name}</p>
            <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded-full border shrink-0 ${HEALTH_STYLES[schedule.health] || ""}`}>{schedule.health}</span>
          </div>
          <p className="text-[11px] text-[var(--inaya-text-muted)] font-mono truncate">
            {PROVIDER_LABELS[schedule.provider]}: {schedule.sourceBucket}{schedule.sourcePrefix ? `/${schedule.sourcePrefix}` : ""} → {schedule.destinationBucket} · every {schedule.intervalHours}h
          </p>
          <p className="text-[10px] text-[var(--inaya-text-muted)]">
            {schedule.lastRunAt ? `last run ${new Date(schedule.lastRunAt).toLocaleString()}` : "never run"} · next due {new Date(schedule.nextRunAt).toLocaleString()}
            {schedule.consecutiveFailures > 0 ? ` · ${schedule.consecutiveFailures} consecutive failure(s)` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={runNow} disabled={busy || schedule.status !== "enabled"} className="text-[11px] font-bold uppercase px-2.5 py-1.5 rounded-md bg-[#00f2fe]/10 text-[#00f2fe] border border-[#00f2fe]/30 disabled:opacity-40">
            Run now
          </button>
          <button onClick={() => act(schedule.status === "enabled" ? "pause" : "resume")} disabled={busy} className="text-[10px] font-bold uppercase text-[#00f2fe] disabled:opacity-40">
            {schedule.status === "enabled" ? "Pause" : "Resume"}
          </button>
          <button onClick={() => act("delete")} disabled={busy} className="text-[10px] font-bold uppercase text-red-400 disabled:opacity-40">Delete</button>
          <button onClick={() => setExpanded((v) => !v)} className="text-[10px] font-bold uppercase text-[var(--inaya-text-muted)]">{expanded ? "Hide" : "History"}</button>
        </div>
      </div>
      {error && <p className="text-red-400 text-[11px]">{error}</p>}
      {runResult && (
        <p className="text-[11px] font-mono text-[var(--inaya-text-muted)]">
          Just ran: <span className={runResult.status === "SUCCESS" ? "text-emerald-400" : "text-amber-400"}>{runResult.status}</span> — seen {runResult.objectsSeen}, changed {runResult.objectsChanged}, copied {runResult.objectsCopied}, verified {runResult.objectsVerified}
        </p>
      )}
      {expanded && <RunHistory orgId={orgId} scheduleId={schedule.id} />}
    </div>
  );
}

function CreateScheduleForm({ orgId, credentials, onChanged }) {
  const [name, setName] = useState("");
  const [credentialId, setCredentialId] = useState("");
  const [sourceBucket, setSourceBucket] = useState("");
  const [sourcePrefix, setSourcePrefix] = useState("");
  const [destinationBucket, setDestinationBucket] = useState("");
  const [intervalHours, setIntervalHours] = useState(6);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const selectedCredential = credentials.find((c) => c.id === credentialId);

  async function create(e) {
    e.preventDefault();
    if (!selectedCredential) return;
    setBusy(true);
    setError("");
    try {
      await api("/api/orgs/backup-schedules", {
        method: "POST",
        body: JSON.stringify({ orgId, name: name.trim(), provider: selectedCredential.provider, credentialId, sourceBucket: sourceBucket.trim(), sourcePrefix: sourcePrefix.trim(), destinationBucket: destinationBucket.trim(), intervalHours: Number(intervalHours) }),
      });
      setName(""); setSourceBucket(""); setSourcePrefix(""); setDestinationBucket("");
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (credentials.length === 0) {
    return <p className="text-[var(--inaya-text-muted)] text-[11px]">Add a cloud credential above before creating a backup schedule.</p>;
  }

  return (
    <form onSubmit={create} className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <input placeholder="Schedule name" value={name} onChange={(e) => setName(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <select value={credentialId} onChange={(e) => setCredentialId(e.target.value)} className="bg-black/30 border border-white/10 rounded-md text-xs px-2 py-1.5 text-[var(--inaya-text-primary)]">
          <option value="">Choose a credential…</option>
          {credentials.map((c) => <option key={c.id} value={c.id}>{c.label || PROVIDER_LABELS[c.provider]} ({PROVIDER_LABELS[c.provider]})</option>)}
        </select>
        <input placeholder="Source bucket" value={sourceBucket} onChange={(e) => setSourceBucket(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input placeholder="Source prefix (optional)" value={sourcePrefix} onChange={(e) => setSourcePrefix(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input placeholder="Destination bucket (Inaya)" value={destinationBucket} onChange={(e) => setDestinationBucket(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input type="number" min="1" value={intervalHours} onChange={(e) => setIntervalHours(e.target.value)} className="w-20 bg-black/30 border border-white/10 rounded-md text-xs px-2 py-1.5 text-[var(--inaya-text-primary)]" />
        <span className="text-[11px] text-[var(--inaya-text-muted)]">hours</span>
        <button type="submit" disabled={busy || !credentialId || !name.trim() || !sourceBucket.trim() || !destinationBucket.trim()} className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg disabled:opacity-40">
          {busy ? "Creating…" : "Create Schedule"}
        </button>
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}
    </form>
  );
}

export default function CloudBackupSchedulerView({ orgId }) {
  const [credentials, setCredentials] = useState(null);
  const [schedules, setSchedules] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const [credData, schedData] = await Promise.all([
        api(`/api/orgs/backup-credentials?orgId=${orgId}`),
        api(`/api/orgs/backup-schedules?orgId=${orgId}`),
      ]);
      setCredentials(credData.credentials);
      setSchedules(schedData.schedules);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-[var(--inaya-text-primary)] font-bold text-sm">Smart Cloud Backup & Health Scheduler</h3>
        <p className="text-[var(--inaya-text-muted)] text-xs mt-0.5">
          Recurring, incremental backups of your own AWS, Azure, or Google Cloud storage into Inaya — only changed objects are re-copied, and every run is verified and health-tracked.
        </p>
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}

      {credentials === null || schedules === null ? (
        <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>
      ) : (
        <>
          <CredentialsPanel orgId={orgId} credentials={credentials} onChanged={load} />

          <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5 space-y-4">
            <p className="text-[var(--inaya-text-primary)] font-bold text-sm">Backup Schedules</p>
            {schedules.length === 0 ? (
              <EmptyState compact icon="☁️" description="No backup schedules yet." />
            ) : (
              <div className="space-y-1.5">
                {schedules.map((s) => <ScheduleRow key={s.id} orgId={orgId} schedule={s} onChanged={load} />)}
              </div>
            )}
            <div className="border-t border-white/5 pt-4">
              <p className="text-[var(--inaya-text-muted)] text-[11px] uppercase font-bold mb-2">Create a schedule</p>
              <CreateScheduleForm orgId={orgId} credentials={credentials} onChanged={load} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
