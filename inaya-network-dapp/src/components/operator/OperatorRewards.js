"use client";

// src/components/operator/OperatorRewards.js
//
// SOW §9-10: tier/commission + rewards/settlements, including the real
// 36-hour on-chain timelock (see nodeChainReads.js). Read-only by design --
// there is no claim button, because releasing an unlocked settlement is
// already fully automated by the existing relayer cron
// (api/nodes/settlements/release/route.js). This never lets an operator
// bypass that delay, and never shows a balance as real when the wallet
// isn't registered on-chain.

import { useState, useEffect } from "react";

async function api(path) {
  const res = await fetch(path);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

function formatCountdown(seconds) {
  if (seconds <= 0) return "Unlocked";
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m remaining`;
}

export default function OperatorRewards() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api("/api/nodes/operator/rewards").then(setData).catch((err) => setError(err.message));
  }, []);

  if (error) return <p className="text-red-400 text-xs">{error}</p>;
  if (!data) return <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>;

  if (!data.available) {
    return (
      <div className="bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-2xl p-6 text-center">
        <p className="text-[var(--inaya-text-muted)] text-sm">{data.reason}</p>
      </div>
    );
  }

  const pending = data.settlements.filter((s) => !s.released);
  const claimed = data.settlements.filter((s) => s.released);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-2xl p-4">
          <p className="text-[var(--inaya-text-muted)] text-[11px] font-mono mb-1">Current Tier</p>
          <p className="text-[var(--inaya-text-primary)] text-xl font-bold">{data.tier}</p>
        </div>
        <div className="bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-2xl p-4">
          <p className="text-[var(--inaya-text-muted)] text-[11px] font-mono mb-1">Commission Rate</p>
          <p className="text-[var(--inaya-text-primary)] text-xl font-bold">{data.commissionPct}%</p>
        </div>
        <div className="bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-2xl p-4">
          <p className="text-[var(--inaya-text-muted)] text-[11px] font-mono mb-1">Total Earned (USDT)</p>
          <p className="text-[var(--inaya-text-primary)] text-xl font-bold tabular-nums">{data.totalEarnedUsdt}</p>
        </div>
      </div>

      <div className="bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-2xl p-4">
        <p className="text-[var(--inaya-text-muted)] text-[11px] font-bold uppercase mb-3">Pending Settlements — 36-Hour Security Delay</p>
        {pending.length === 0 ? (
          <p className="text-[var(--inaya-text-muted)] text-sm italic">No pending settlements right now.</p>
        ) : (
          <div className="space-y-2">
            {pending.map((s, i) => (
              <div key={i} className="flex items-center justify-between bg-black/10 border border-[var(--inaya-border)] rounded-lg p-3">
                <div>
                  <p className="text-[var(--inaya-text-primary)] text-sm font-mono tabular-nums">{s.amount} USDT</p>
                  <p className="text-[var(--inaya-text-muted)] text-[11px]">Unlocks {new Date(s.unlockTime).toLocaleString()}</p>
                </div>
                <span className={`text-[11px] font-bold uppercase px-2 py-0.5 rounded-full border ${s.isClaimable ? "bg-emerald-400/10 text-emerald-400 border-emerald-400/30" : "bg-amber-400/10 text-amber-400 border-amber-400/30"}`}>
                  {s.isClaimable ? "Claimable" : formatCountdown(s.secondsRemaining)}
                </span>
              </div>
            ))}
          </div>
        )}
        <p className="text-[var(--inaya-text-muted)] text-[11px] mt-3">
          Claimable settlements are released automatically once unlocked — nothing to claim manually here.
        </p>
      </div>

      {claimed.length > 0 && (
        <div className="bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-2xl p-4">
          <p className="text-[var(--inaya-text-muted)] text-[11px] font-bold uppercase mb-3">Released</p>
          <div className="space-y-2">
            {claimed.map((s, i) => (
              <div key={i} className="flex items-center justify-between text-xs">
                <span className="text-[var(--inaya-text-primary)] font-mono tabular-nums">{s.amount} USDT</span>
                <span className="text-[var(--inaya-text-muted)]">{new Date(s.unlockTime).toLocaleDateString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
