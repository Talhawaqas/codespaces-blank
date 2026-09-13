"use client";

// src/components/operator/OperatorNetwork.js
//
// SOW §14: network-level context, no session required (public/operator-
// level, never another operator's private data). Clearly separate section
// from the personal stats elsewhere on this dashboard.

import { useState, useEffect } from "react";

async function api(path) {
  const res = await fetch(path);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

export default function OperatorNetwork() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api("/api/nodes/operator/network").then(setData).catch((err) => setError(err.message));
  }, []);

  if (error) return <p className="text-red-400 text-xs">{error}</p>;
  if (!data) return <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-2xl p-4">
          <p className="text-[var(--inaya-text-muted)] text-[11px] font-mono mb-1">Registered Nodes</p>
          <p className="text-[var(--inaya-text-primary)] text-2xl font-bold tabular-nums">{data.totalRegisteredNodes}</p>
        </div>
        <div className="bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-2xl p-4">
          <p className="text-[var(--inaya-text-muted)] text-[11px] font-mono mb-1">Active Now</p>
          <p className="text-[var(--inaya-text-primary)] text-2xl font-bold tabular-nums">{data.activeNodes}</p>
        </div>
        <div className="bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-2xl p-4">
          <p className="text-[var(--inaya-text-muted)] text-[11px] font-mono mb-1">Network Stage</p>
          <p className="text-[var(--inaya-text-primary)] text-2xl font-bold capitalize">{data.networkStage}</p>
        </div>
        <div className="bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-2xl p-4">
          <p className="text-[var(--inaya-text-muted)] text-[11px] font-mono mb-1">Expected Daemon Version</p>
          <p className="text-[var(--inaya-text-primary)] text-2xl font-bold font-mono">{data.expectedDaemonVersion}</p>
        </div>
      </div>

      <div className="bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-2xl p-4">
        <p className="text-[var(--inaya-text-muted)] text-[11px] font-bold uppercase mb-3">Tier Distribution</p>
        <div className="space-y-2">
          {Object.entries(data.tierDistribution).map(([tier, count]) => {
            const pct = data.totalRegisteredNodes ? Math.round((count / data.totalRegisteredNodes) * 100) : 0;
            return (
              <div key={tier}>
                <div className="flex items-center justify-between text-xs mb-1">
                  <span className="text-[var(--inaya-text-primary)]">{tier}</span>
                  <span className="text-[var(--inaya-text-muted)] font-mono">{count} ({pct}%)</span>
                </div>
                <div className="h-1.5 rounded-full bg-[var(--inaya-overlay-10)] overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: `${pct}%`, background: "linear-gradient(90deg, #00f2fe, #4facfe)" }} />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <p className="text-[var(--inaya-text-muted)] text-[11px]">
        This tier distribution reads each node's last-registered tier, a rough network-wide picture — not a per-operator authoritative value (see your own Tier &amp; Rewards tab for that, read live from the chain).
      </p>
    </div>
  );
}
