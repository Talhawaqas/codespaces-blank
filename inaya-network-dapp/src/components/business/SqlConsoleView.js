"use client";

// src/components/business/SqlConsoleView.js
//
// Mainframe & Legacy Data Access + Real-Time SQL Virtualization SOW,
// Section 24 -- SQL Workspace / Developer Console. A real, permission-
// gated query editor against sqlGateway.js's real executeVirtualQuery()
// -- no client-side query simulation. Read-only by construction: the
// gateway itself rejects anything but SELECT.

import { useState, useEffect, useCallback } from "react";

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

export default function SqlConsoleView({ orgId }) {
  const [dataSources, setDataSources] = useState([]);
  const [dataSourceId, setDataSourceId] = useState("");
  const [sql, setSql] = useState("SELECT * FROM ");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  const loadSources = useCallback(async () => {
    try {
      const res = await api(`/api/orgs/data-sources?orgId=${orgId}`);
      setDataSources(res.dataSources);
      if (res.dataSources.length > 0 && !dataSourceId) setDataSourceId(res.dataSources[0]._id);
    } catch (err) {
      setError(err.message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  useEffect(() => { loadSources(); }, [loadSources]);

  async function runQuery() {
    if (!dataSourceId) {
      setError("Select a data source first.");
      return;
    }
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const res = await api(`/api/orgs/data-sources/${dataSourceId}/query`, { method: "POST", body: JSON.stringify({ orgId, sql }) });
      setResult(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <select value={dataSourceId} onChange={(e) => setDataSourceId(e.target.value)} className="rounded border border-white/10 bg-transparent px-3 py-2 text-sm">
          <option value="" disabled>Select a data source…</option>
          {dataSources.map((ds) => (
            <option key={ds._id} value={ds._id}>{ds.name} ({ds.status})</option>
          ))}
        </select>
        <button onClick={runQuery} disabled={busy} className="rounded bg-[var(--inaya-accent)] px-4 py-2 text-sm font-medium disabled:opacity-50">
          {busy ? "Running…" : "Run Query"}
        </button>
        <span className="text-xs text-[var(--inaya-text-muted)]">Read-only — SELECT only. Only virtual tables published for this source can be queried.</span>
      </div>

      <textarea
        value={sql} onChange={(e) => setSql(e.target.value)} rows={6} spellCheck={false}
        className="w-full rounded border border-white/10 bg-black/20 px-3 py-2 font-mono text-sm"
        placeholder="SELECT * FROM my_table WHERE ..."
      />

      {error && <div className="rounded border border-red-400/30 bg-red-400/10 px-3 py-2 text-sm text-red-400">{error}</div>}

      {result && (
        <div className="space-y-2">
          <div className="text-xs text-[var(--inaya-text-muted)]">
            {result.rowCount} row(s){result.truncated ? " (truncated)" : ""} in {result.elapsedMs}ms — tables used: {result.tablesUsed?.join(", ")}
          </div>
          <div className="overflow-x-auto rounded border border-white/10">
            <table className="min-w-full text-xs">
              <thead>
                <tr className="border-b border-white/10">
                  {result.columns?.map((c) => (
                    <th key={c} className="px-3 py-2 text-left font-mono">{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.rows?.map((row, i) => (
                  <tr key={i} className="border-b border-white/5">
                    {result.columns?.map((c) => (
                      <td key={c} className="px-3 py-1.5 font-mono">{row[c] === null ? <em className="text-[var(--inaya-text-muted)]">null</em> : String(row[c])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
