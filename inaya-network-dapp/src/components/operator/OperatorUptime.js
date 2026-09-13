"use client";

// src/components/operator/OperatorUptime.js
//
// SOW §7: uptime + telemetry history over selectable windows. Honesty is
// the whole point here -- insufficientData renders an explicit "not
// enough data yet" state rather than a number that looks complete but
// isn't (heartbeatLog only retains ~100 minutes; real history only starts
// accumulating from when the hourly snapshot cron first ran).

import { useState, useEffect, useCallback } from "react";

async function api(path) {
  const res = await fetch(path);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

const WINDOWS = [["24h", "24 Hours"], ["7d", "7 Days"], ["30d", "30 Days"], ["90d", "90 Days"], ["lifetime", "Lifetime"]];

function formatDuration(ms) {
  const hours = ms / (60 * 60 * 1000);
  if (hours < 24) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

export default function OperatorUptime() {
  const [window_, setWindow] = useState("24h");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setData(await api(`/api/nodes/operator/uptime?window=${window_}`));
      setError("");
    } catch (err) {
      setError(err.message);
    }
  }, [window_]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-xl p-1 w-fit">
        {WINDOWS.map(([value, label]) => (
          <button
            key={value}
            onClick={() => setWindow(value)}
            className="px-3 py-1.5 text-xs font-bold rounded-lg"
            style={window_ === value ? { background: "color-mix(in srgb, var(--inaya-accent) 15%, transparent)", color: "var(--inaya-accent)" } : { color: "var(--inaya-text-muted)" }}
          >
            {label}
          </button>
        ))}
      </div>

      {error && <p className="text-red-400 text-xs">{error}</p>}
      {!data ? (
        <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>
      ) : data.percentUptime === undefined ? (
        <div className="bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-2xl p-6 text-center">
          <p className="text-[var(--inaya-text-muted)] text-sm">{data.reason || "Not enough observed data to calculate this metric yet."}</p>
        </div>
      ) : (
        <div className="space-y-4">
          {data.insufficientData && (
            <p className="text-amber-400 text-[11px] font-semibold">
              Partial data — telemetry has only been recorded since {new Date(data.coverageStart).toLocaleString()}.
            </p>
          )}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-2xl p-4">
              <p className="text-[var(--inaya-text-muted)] text-[11px] font-mono mb-1">Uptime</p>
              <p className="text-[var(--inaya-text-primary)] text-2xl font-bold tabular-nums">{data.percentUptime}%</p>
            </div>
            <div className="bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-2xl p-4">
              <p className="text-[var(--inaya-text-muted)] text-[11px] font-mono mb-1">Outages</p>
              <p className="text-[var(--inaya-text-primary)] text-2xl font-bold tabular-nums">{data.outageCount}</p>
            </div>
            <div className="bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-2xl p-4">
              <p className="text-[var(--inaya-text-muted)] text-[11px] font-mono mb-1">Longest Outage</p>
              <p className="text-[var(--inaya-text-primary)] text-2xl font-bold tabular-nums">{data.longestOutageMs ? formatDuration(data.longestOutageMs) : "—"}</p>
            </div>
            <div className="bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-2xl p-4">
              <p className="text-[var(--inaya-text-muted)] text-[11px] font-mono mb-1">Observed</p>
              <p className="text-[var(--inaya-text-primary)] text-2xl font-bold tabular-nums">{formatDuration(data.totalObservedMs)}</p>
            </div>
          </div>

          {data.mostRecentOutage && (
            <div className="bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-2xl p-4">
              <p className="text-[var(--inaya-text-muted)] text-[11px] font-bold uppercase mb-1">Most Recent Outage</p>
              <p className="text-[var(--inaya-text-primary)] text-sm font-mono">
                {new Date(data.mostRecentOutage.start).toLocaleString()} {data.mostRecentOutage.end ? `→ ${new Date(data.mostRecentOutage.end).toLocaleString()}` : "(ongoing)"}
              </p>
            </div>
          )}

          <p className="text-[var(--inaya-text-muted)] text-[11px]">
            Uptime is calculated from successfully observed node telemetry, sampled hourly, during the displayed measurement period.
          </p>
        </div>
      )}
    </div>
  );
}
