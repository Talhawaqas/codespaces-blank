"use client";

// src/components/operator/OperatorOverview.js
//
// SOW §4-6: the primary status cards + node identity/registration + live
// health section, all from GET /api/nodes/operator/me's single payload.
// Every value here traces back to a real field on the `nodes` doc, the
// chain, or the threat-reputation snapshot -- never a decorative number.

import { useState } from "react";

const STATUS_STYLE = {
  healthy: { label: "Healthy", className: "bg-emerald-400/10 text-emerald-400 border-emerald-400/30" },
  degraded: { label: "Degraded", className: "bg-amber-400/10 text-amber-400 border-amber-400/30" },
  offline: { label: "Offline", className: "bg-red-400/10 text-red-400 border-red-400/30" },
  unknown: { label: "Unknown", className: "bg-white/5 text-[var(--inaya-text-muted)] border-white/10" },
};

function relativeTime(iso) {
  if (!iso) return "Never";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function CopyableField({ label, value }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be blocked (permissions, insecure context) --
      // failing silently here is fine, the value is still visible to
      // select/copy manually.
    }
  }
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span className="text-[var(--inaya-text-muted)]">{label}</span>
      <button onClick={handleCopy} className="font-mono text-[var(--inaya-text-primary)] truncate max-w-[220px] hover:text-[var(--inaya-accent)]" title={value}>
        {copied ? "Copied!" : value}
      </button>
    </div>
  );
}

export default function OperatorOverview({ initialData, onRefresh }) {
  const [refreshing, setRefreshing] = useState(false);
  const { primary } = initialData;

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  }

  const status = STATUS_STYLE[primary.status] || STATUS_STYLE.unknown;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-[var(--inaya-text-muted)] text-[11px] font-mono">Updated just now</p>
        <button onClick={handleRefresh} disabled={refreshing} className="text-[11px] font-bold uppercase text-[var(--inaya-accent)] disabled:opacity-40">
          {refreshing ? "Refreshing…" : "↻ Refresh"}
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <div className="bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-2xl p-4">
          <p className="text-[var(--inaya-text-muted)] text-[11px] font-mono mb-2">Node Status</p>
          <span className={`inline-block text-xs font-bold uppercase px-2 py-1 rounded-full border ${status.className}`}>{status.label}</span>
        </div>
        <div className="bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-2xl p-4">
          <p className="text-[var(--inaya-text-muted)] text-[11px] font-mono mb-1">Last Seen</p>
          <p className="text-[var(--inaya-text-primary)] text-lg font-bold">{relativeTime(primary.telemetry.lastHeartbeatAt)}</p>
          {primary.telemetry.lastHeartbeatAt && <p className="text-[var(--inaya-text-muted)] text-[11px] font-mono">{new Date(primary.telemetry.lastHeartbeatAt).toLocaleString()}</p>}
        </div>
        <div className="bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-2xl p-4">
          <p className="text-[var(--inaya-text-muted)] text-[11px] font-mono mb-1">Node Tier</p>
          {primary.tier.source === "on_chain" ? (
            <p className="text-[var(--inaya-text-primary)] text-lg font-bold">{primary.tier.name} <span className="text-[var(--inaya-text-muted)] text-xs font-mono">({primary.tier.commissionPct}%)</span></p>
          ) : (
            <p className="text-[var(--inaya-text-muted)] text-xs italic">{primary.tier.reason}</p>
          )}
        </div>
        <div className="bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-2xl p-4">
          <p className="text-[var(--inaya-text-muted)] text-[11px] font-mono mb-1">Uptime Score</p>
          <p className="text-[var(--inaya-text-primary)] text-lg font-bold tabular-nums">
            {primary.telemetry.uptimeScoreBps != null ? `${(primary.telemetry.uptimeScoreBps / 100).toFixed(1)}%` : "—"}
          </p>
        </div>
        <div className="bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-2xl p-4">
          <p className="text-[var(--inaya-text-muted)] text-[11px] font-mono mb-1">Storage</p>
          <p className="text-[var(--inaya-text-primary)] text-lg font-bold tabular-nums">{primary.telemetry.usedCapacityGB} / {primary.telemetry.totalCapacityGB} GB</p>
        </div>
        <div className="bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-2xl p-4">
          <p className="text-[var(--inaya-text-muted)] text-[11px] font-mono mb-1">Shards Stored</p>
          <p className="text-[var(--inaya-text-primary)] text-lg font-bold tabular-nums">{primary.telemetry.shardsStored}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-2xl p-4 space-y-2.5">
          <p className="text-[var(--inaya-text-muted)] text-[11px] font-bold uppercase">Identity &amp; Registration</p>
          <CopyableField label="Node ID" value={primary.identity.nodeId} />
          <CopyableField label="Operator Wallet" value={primary.identity.operatorWallet} />
          <div className="flex items-center justify-between text-xs">
            <span className="text-[var(--inaya-text-muted)]">Registered</span>
            <span className="text-[var(--inaya-text-primary)] font-mono">{new Date(primary.identity.registeredAt).toLocaleDateString()}</span>
          </div>
        </div>

        <div className="bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-2xl p-4 space-y-2.5">
          <p className="text-[var(--inaya-text-muted)] text-[11px] font-bold uppercase">Software &amp; Health</p>
          <div className="flex items-center justify-between text-xs">
            <span className="text-[var(--inaya-text-muted)]">Daemon Version</span>
            <span className="text-[var(--inaya-text-primary)] font-mono">{primary.version.daemonVersion || "Unknown"}</span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-[var(--inaya-text-muted)]">Daemon Restarts</span>
            <span className="text-[var(--inaya-text-primary)] font-mono">{primary.version.restartCount ?? "—"}</span>
          </div>
          {primary.telemetry.lastErrorMessage && (
            <div className="text-xs">
              <span className="text-[var(--inaya-text-muted)]">Last Error</span>
              <p className="text-red-400 font-mono mt-0.5">{primary.telemetry.lastErrorMessage}</p>
              {primary.telemetry.lastErrorAt && <p className="text-[var(--inaya-text-muted)] text-[11px]">{new Date(primary.telemetry.lastErrorAt).toLocaleString()}</p>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
