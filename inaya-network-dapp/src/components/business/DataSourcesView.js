"use client";

// src/components/business/DataSourcesView.js
//
// Mainframe & Legacy Data Access + Real-Time SQL Virtualization SOW,
// Section 23 -- Connector Administration UI. Same self-contained-view
// pattern as CloudBackupSchedulerView.js (provider-specific credential
// form) and IntegrationsView.js (catalog + explicit status states) --
// all thin, real calls against the real API routes, no client-side
// simulation of a connection test or metadata import.

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../EmptyState";

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

// Only "relational" is a real, implemented connector this pass --
// Adabas/VSAM/IMS/RMS-OpenVMS are not offered here because they don't
// exist yet, not because the UI forgot them. See
// docs/MAINFRAME_DATA_ACCESS_CAPABILITY_AUDIT.md.
const CONNECTOR_FIELDS = {
  relational: [
    { key: "filePath", label: "SQLite file path", placeholder: "/path/to/database.sqlite" },
  ],
};

const CONNECTOR_LABELS = {
  relational: "Relational (SQLite reference connector)",
};

const STATUS_STYLES = {
  CONNECTED: "bg-emerald-400/10 text-emerald-400 border-emerald-400/30",
  DEGRADED: "bg-amber-400/10 text-amber-400 border-amber-400/30",
  AUTHENTICATION_FAILED: "bg-red-400/10 text-red-400 border-red-400/30",
  SOURCE_UNAVAILABLE: "bg-red-400/10 text-red-400 border-red-400/30",
  SCHEMA_ERROR: "bg-amber-400/10 text-amber-400 border-amber-400/30",
  DISABLED: "border-white/10 text-[var(--inaya-text-muted)]",
  UNKNOWN: "border-white/10 text-[var(--inaya-text-muted)]",
};

function RegisterForm({ orgId, onChanged }) {
  const [name, setName] = useState("");
  const [connectorType, setConnectorType] = useState("relational");
  const [fields, setFields] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/orgs/data-sources", { method: "POST", body: JSON.stringify({ orgId, name: name.trim(), connectorType, credentials: fields }) });
      setName("");
      setFields({});
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="rounded-lg border border-white/10 p-4 space-y-3">
      <div className="text-sm font-semibold">Register a data source</div>
      <input
        type="text" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required
        className="w-full rounded border border-white/10 bg-transparent px-3 py-2 text-sm"
      />
      <select value={connectorType} onChange={(e) => { setConnectorType(e.target.value); setFields({}); }} className="w-full rounded border border-white/10 bg-transparent px-3 py-2 text-sm">
        {Object.keys(CONNECTOR_FIELDS).map((type) => (
          <option key={type} value={type}>{CONNECTOR_LABELS[type]}</option>
        ))}
      </select>
      {CONNECTOR_FIELDS[connectorType].map((f) => (
        <input
          key={f.key} type="text" placeholder={f.label} value={fields[f.key] || ""}
          onChange={(e) => setFields((prev) => ({ ...prev, [f.key]: e.target.value }))}
          required className="w-full rounded border border-white/10 bg-transparent px-3 py-2 text-sm"
        />
      ))}
      {error && <div className="text-sm text-red-400">{error}</div>}
      <button type="submit" disabled={busy} className="rounded bg-[var(--inaya-accent)] px-4 py-2 text-sm font-medium disabled:opacity-50">
        {busy ? "Registering…" : "Register & Test Connection"}
      </button>
      <p className="text-xs text-[var(--inaya-text-muted)]">
        Adabas/VSAM/IMS/RMS-OpenVMS connectors aren&apos;t offered here yet — they require a real vendor
        environment to validate against, not yet available. See the completion report for status.
      </p>
    </form>
  );
}

function DataSourceRow({ orgId, dataSource, onChanged }) {
  const [expanded, setExpanded] = useState(false);
  const [tables, setTables] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function test() {
    setBusy(true);
    setError("");
    try {
      await api(`/api/orgs/data-sources/${dataSource._id}`, { method: "PATCH", body: JSON.stringify({ orgId, action: "test" }) });
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function importSchema() {
    setBusy(true);
    setError("");
    try {
      const result = await api(`/api/orgs/data-sources/${dataSource._id}/metadata`, { method: "POST", body: JSON.stringify({ orgId }) });
      setTables(result.tables);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function loadTables() {
    setExpanded((prev) => !prev);
    if (!tables) {
      try {
        const result = await api(`/api/orgs/data-sources/${dataSource._id}/metadata?orgId=${orgId}`);
        setTables(result.tables);
      } catch (err) {
        setError(err.message);
      }
    }
  }

  async function remove() {
    if (!confirm(`Delete data source "${dataSource.name}"? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await api(`/api/orgs/data-sources/${dataSource._id}`, { method: "DELETE", body: JSON.stringify({ orgId }) });
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-white/10 p-4 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="font-medium">{dataSource.name}</div>
          <div className="text-xs text-[var(--inaya-text-muted)]">{CONNECTOR_LABELS[dataSource.connectorType] || dataSource.connectorType}</div>
        </div>
        <span className={`rounded-full border px-2.5 py-0.5 text-xs ${STATUS_STYLES[dataSource.status] || STATUS_STYLES.UNKNOWN}`}>{dataSource.status}</span>
      </div>
      {dataSource.lastHealthDetail && <div className="text-xs text-[var(--inaya-text-muted)]">{dataSource.lastHealthDetail}</div>}
      {error && <div className="text-sm text-red-400">{error}</div>}
      <div className="flex flex-wrap gap-2 pt-1">
        <button onClick={test} disabled={busy} className="rounded border border-white/10 px-3 py-1.5 text-xs">Test Connection</button>
        <button onClick={importSchema} disabled={busy} className="rounded border border-white/10 px-3 py-1.5 text-xs">Import &amp; Publish Schema</button>
        <button onClick={loadTables} className="rounded border border-white/10 px-3 py-1.5 text-xs">{expanded ? "Hide" : "Show"} Virtual Tables</button>
        <button onClick={remove} disabled={busy} className="rounded border border-red-400/30 text-red-400 px-3 py-1.5 text-xs">Delete</button>
      </div>
      {expanded && (
        <div className="pt-2 space-y-1">
          {tables === null && <div className="text-xs text-[var(--inaya-text-muted)]">Loading…</div>}
          {tables?.length === 0 && <div className="text-xs text-[var(--inaya-text-muted)]">No virtual tables published yet — import the schema first.</div>}
          {tables?.map((t) => (
            <div key={t.name} className="rounded border border-white/10 px-3 py-2 text-xs">
              <div className="font-mono font-medium">{t.name}</div>
              <div className="text-[var(--inaya-text-muted)]">{t.columns.map((c) => `${c.name}: ${c.sqlType}`).join(", ")}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function DataSourcesView({ orgId }) {
  const [dataSources, setDataSources] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const result = await api(`/api/orgs/data-sources?orgId=${orgId}`);
      setDataSources(result.dataSources);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-6">
      <RegisterForm orgId={orgId} onChanged={load} />
      {error && <div className="text-sm text-red-400">{error}</div>}
      {dataSources === null && <div className="text-sm text-[var(--inaya-text-muted)]">Loading…</div>}
      {dataSources?.length === 0 && (
        <EmptyState title="No data sources yet" description="Register a data source above to start virtualizing it as live SQL." />
      )}
      <div className="space-y-3">
        {dataSources?.map((ds) => (
          <DataSourceRow key={ds._id} orgId={orgId} dataSource={ds} onChanged={load} />
        ))}
      </div>
    </div>
  );
}
