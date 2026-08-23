"use client";

// app/stats/page.js
//
// Public, real-time Network Stats page — no wallet, no login. Every
// number here comes from /api/network-stats, which itself only
// aggregates functions already trusted elsewhere in this codebase
// (getPublicSecurityStats already powers /security's live stats,
// getAllActiveUserStats already powers the admin dashboard) — nothing
// invented for this page specifically. Same visual language as
// /security (ambient glow, dark card grid) since it's the closest
// existing precedent for a public transparency page.

import { useState, useEffect, useCallback } from "react";

export default function NetworkStatsPage() {
  const [stats, setStats] = useState(null);
  const [loadError, setLoadError] = useState("");

  const loadStats = useCallback(async () => {
    setLoadError("");
    try {
      const res = await fetch("/api/network-stats");
      if (!res.ok) throw new Error("Could not load network stats.");
      setStats(await res.json());
    } catch (err) {
      setLoadError(err.message);
    }
  }, []);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  return (
    <div className="relative min-h-screen bg-[#060913] text-[#e2e8f0] font-sans px-4 py-16 md:px-10 overflow-hidden">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-24 -left-24 w-96 h-96 rounded-full bg-[#00f2fe]/10 blur-[120px]" />
        <div className="absolute bottom-0 right-0 w-96 h-96 rounded-full bg-[#c9a24d]/8 blur-[120px]" />
      </div>

      <div className="relative max-w-4xl mx-auto">
        <a href="/" className="inline-flex items-center gap-2 text-[#64748b] hover:text-[#00f2fe] text-xs font-mono mb-8 transition-colors">
          ← Back to Inaya Network
        </a>

        <div className="flex items-center gap-2 bg-black/40 border border-emerald-400/30 rounded-full px-3 py-1 mb-4 w-fit">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400" />
          </span>
          <span className="text-emerald-300 text-[10px] font-bold tracking-wider">LIVE</span>
        </div>
        <h1 className="text-3xl sm:text-4xl font-black text-white tracking-tight mb-3">Network Stats</h1>
        <p className="text-[#94a3b8] text-sm max-w-2xl mb-10">
          Real-time, public numbers pulled directly from the same data the admin dashboard and the Security Layer transparency page use — nothing curated for this page specifically.{" "}
          <span className="text-[#64748b]">Currently running on BNB Chain Testnet.</span>
        </p>

        {loadError && <p className="text-red-400 text-sm mb-6">{loadError}</p>}

        <section className="mb-10">
          <h2 className="text-white font-bold text-sm mb-4 flex items-center gap-2"><span>👥</span> Active Users</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {[
              { label: "dApp", data: stats?.activeUsers?.dapp },
              { label: "Business Workspace", data: stats?.activeUsers?.business },
              { label: "Mobile", data: stats?.activeUsers?.mobile },
            ].map((s) => (
              <div key={s.label} className="bg-[#0a0f1e] border border-white/10 border-t-2 border-t-[#00f2fe]/60 rounded-xl p-5">
                <div className="text-[#64748b] text-[10px] uppercase tracking-wider mb-2">{s.label}</div>
                <div className="flex items-baseline gap-4">
                  <div>
                    <div className="text-2xl font-extrabold text-white">{s.data ? s.data.dau : "—"}</div>
                    <div className="text-[#64748b] text-[10px]">DAU</div>
                  </div>
                  <div>
                    <div className="text-2xl font-extrabold text-white">{s.data ? s.data.wau : "—"}</div>
                    <div className="text-[#64748b] text-[10px]">WAU</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="mb-10">
          <h2 className="text-white font-bold text-sm mb-4 flex items-center gap-2"><span>🛡️</span> Security Layer</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="bg-[#0a0f1e] border border-white/10 border-t-2 border-t-[#f87171]/60 rounded-xl p-5">
              <div className="text-3xl font-extrabold text-[#f87171]">{stats ? stats.security.confirmedThreatsCount : "—"}</div>
              <div className="text-[#64748b] text-xs mt-1">Confirmed Threats</div>
            </div>
            <div className="bg-[#0a0f1e] border border-white/10 border-t-2 border-t-[#00f2fe]/60 rounded-xl p-5">
              <div className="text-3xl font-extrabold text-white">{stats ? stats.security.reportingNodesCount : "—"}</div>
              <div className="text-[#64748b] text-xs mt-1">Reporting Nodes</div>
            </div>
            <div className="bg-[#0a0f1e] border border-white/10 border-t-2 border-t-[#c084fc]/60 rounded-xl p-5">
              <div className="text-3xl font-extrabold text-white">{stats && stats.security.avgReputationBps != null ? `${(stats.security.avgReputationBps / 100).toFixed(1)}%` : "—"}</div>
              <div className="text-[#64748b] text-xs mt-1">Avg Node Reputation</div>
            </div>
          </div>
          <a href="/security" className="inline-block mt-3 text-[#00f2fe] text-xs font-bold hover:underline">Explore the Security Layer →</a>
        </section>

        <section className="mb-10">
          <h2 className="text-white font-bold text-sm mb-4 flex items-center gap-2"><span>🤝</span> Community</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="bg-[#0a0f1e] border border-white/10 border-t-2 border-t-[#4facfe]/60 rounded-xl p-5">
              <div className="text-3xl font-extrabold text-white">{stats ? stats.community.verifiedReferrersCount : "—"}</div>
              <div className="text-[#64748b] text-xs mt-1">Verified Referrers</div>
            </div>
            <div className="bg-[#0a0f1e] border border-white/10 border-t-2 border-t-[#f2a900]/60 rounded-xl p-5">
              <div className="text-3xl font-extrabold text-white">{stats ? stats.community.totalInayaDistributed : "—"} <span className="text-sm text-[#64748b]">$INAYA</span></div>
              <div className="text-[#64748b] text-xs mt-1">Distributed via Referrals</div>
            </div>
          </div>
        </section>

        {stats?.generatedAt && (
          <p className="text-[#64748b] text-[10px] font-mono">Last updated {new Date(stats.generatedAt).toLocaleString()}</p>
        )}
      </div>
    </div>
  );
}
