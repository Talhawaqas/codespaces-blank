"use client";

// src/components/operator/OperatorQualification.js
//
// SOW §8: the 90-day/95%-uptime tracker. Backend-calculated only
// (nodeUptimeHistory.js's advanceQualificationForNode), never a client-side
// approximation -- this component just renders whatever
// GET /api/nodes/operator/qualification returns.

import { useState, useEffect } from "react";

async function api(path) {
  const res = await fetch(path);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

const STATUS_STYLE = {
  qualified: { label: "Qualified", className: "bg-emerald-400/10 text-emerald-400 border-emerald-400/30" },
  on_track: {
    label: "On Track",
    className: "",
    style: { background: "color-mix(in srgb, var(--inaya-accent) 10%, transparent)", color: "var(--inaya-accent)", borderColor: "color-mix(in srgb, var(--inaya-accent) 30%, transparent)" },
  },
  at_risk: { label: "At Risk", className: "bg-amber-400/10 text-amber-400 border-amber-400/30" },
  insufficient_data: { label: "Insufficient Data", className: "bg-white/5 text-[var(--inaya-text-muted)] border-white/10" },
};

export default function OperatorQualification() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api("/api/nodes/operator/qualification").then(setData).catch((err) => setError(err.message));
  }, []);

  if (error) return <p className="text-red-400 text-xs">{error}</p>;
  if (!data) return <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>;

  const status = STATUS_STYLE[data.status] || STATUS_STYLE.insufficient_data;
  const progressPct = Math.min(100, Math.round((data.consecutiveQualifyingDays / data.requiredDays) * 100));

  return (
    <div className="space-y-4">
      <div className="bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-2xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-[var(--inaya-text-primary)] font-bold text-sm">{data.requiredDays}-Day Testnet Qualification</p>
          <span className={`text-[11px] font-bold uppercase px-2 py-0.5 rounded-full border ${status.className}`} style={status.style}>{status.label}</span>
        </div>

        {data.status === "insufficient_data" ? (
          <p className="text-[var(--inaya-text-muted)] text-sm">{data.reason}</p>
        ) : (
          <>
            <div>
              <div className="flex items-baseline justify-between mb-1.5">
                <span className="text-[var(--inaya-text-primary)] text-2xl font-bold tabular-nums">{data.consecutiveQualifyingDays}</span>
                <span className="text-[var(--inaya-text-muted)] text-xs font-mono">of {data.requiredDays} consecutive days</span>
              </div>
              <div className="h-2 rounded-full bg-[var(--inaya-overlay-10)] overflow-hidden">
                <div className="h-full rounded-full" style={{ width: `${progressPct}%`, background: "linear-gradient(90deg, #00f2fe, #4facfe)" }} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <p className="text-[var(--inaya-text-muted)]">Required threshold</p>
                <p className="text-[var(--inaya-text-primary)] font-mono">{(data.thresholdBps / 100).toFixed(0)}%+ daily average uptime</p>
              </div>
              <div>
                <p className="text-[var(--inaya-text-muted)]">Days remaining</p>
                <p className="text-[var(--inaya-text-primary)] font-mono">{data.daysRemaining}</p>
              </div>
              {data.periodStart && (
                <div>
                  <p className="text-[var(--inaya-text-muted)]">Current streak started</p>
                  <p className="text-[var(--inaya-text-primary)] font-mono">{data.periodStart}</p>
                </div>
              )}
            </div>

            {data.lastResetReason && (
              <div className="border-t border-[var(--inaya-border)] pt-3">
                <p className="text-[var(--inaya-text-muted)] text-[11px] font-bold uppercase mb-1">Last Reset</p>
                <p className="text-amber-400 text-xs">{data.lastResetReason}</p>
                {data.lastResetAt && <p className="text-[var(--inaya-text-muted)] text-[11px] mt-0.5">{new Date(data.lastResetAt).toLocaleString()}</p>}
              </div>
            )}
          </>
        )}
      </div>

      <p className="text-[var(--inaya-text-muted)] text-[11px]">
        Qualification tracking is calculated from real hourly telemetry snapshots, starting from when this dashboard went live — a streak cannot include days before that.
      </p>
    </div>
  );
}
