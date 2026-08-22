"use client";

// app/security/page.js
//
// Public Security Layer transparency page — no wallet, no login. Anyone
// can check a destination or see network-wide stats for the decentralized
// threat-intelligence system (Security Layer SOW). Every number here comes
// from the same public routes the mobile app's Security screen and the
// desktop app's link-checker already use (/api/security/stats,
// /api/security/threat, /api/security/feed) — nothing admin-only is ever
// exposed here (no raw node addresses, no report-level detail — see
// getPublicSecurityStats()'s own comment in src/lib/security.js).

import { useState, useEffect, useCallback } from "react";
import NetworkVisualization from "../../components/security/NetworkVisualization";

const CATEGORIES = ["Unknown", "Phishing", "Malware", "Scam", "Botnet/C2", "Spam", "Other"];

function formatPct(bps) {
  return bps == null ? "—" : `${(bps / 100).toFixed(1)}%`;
}

function formatDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

export default function SecurityTransparencyPage() {
  const [stats, setStats] = useState(null);
  const [feed, setFeed] = useState([]);
  const [loadError, setLoadError] = useState("");

  const [checkInput, setCheckInput] = useState("");
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState(null);

  const loadData = useCallback(async () => {
    setLoadError("");
    try {
      const [statsRes, feedRes] = await Promise.all([fetch("/api/security/stats"), fetch("/api/security/feed")]);
      if (!statsRes.ok || !feedRes.ok) throw new Error("Could not load Security Layer data.");
      setStats(await statsRes.json());
      setFeed((await feedRes.json()).items.slice(0, 20));
    } catch (err) {
      setLoadError(err.message);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  async function handleCheck(e) {
    e.preventDefault();
    const indicator = checkInput.trim();
    if (!indicator) return;
    setChecking(true);
    setCheckResult(null);
    try {
      const res = await fetch(`/api/security/threat?indicator=${encodeURIComponent(indicator)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Check failed.");
      setCheckResult(data);
    } catch (err) {
      setCheckResult({ error: err.message });
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#060913] text-[#e2e8f0] font-sans px-4 py-12 md:px-10">
      <div className="max-w-4xl mx-auto">
        <div className="relative overflow-hidden bg-[#050810] border border-white/10 rounded-2xl mb-8">
          <NetworkVisualization height={280} />
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-6 pointer-events-none bg-gradient-to-b from-transparent via-transparent to-[#050810]/70">
            <h1 className="text-3xl font-extrabold text-white drop-shadow-[0_2px_12px_rgba(0,0,0,0.8)]">Inaya Security Layer</h1>
            <p className="text-[#cbd5e1] text-xs sm:text-sm mt-2 drop-shadow-[0_2px_8px_rgba(0,0,0,0.9)]">
              Independent nodes, reputation-weighted, on-chain anchored
            </p>
          </div>
        </div>

        <p className="text-[#94a3b8] text-sm max-w-2xl mb-10">
          Decentralized threat intelligence backed by independent Inaya nodes — a destination is only ever marked
          confirmed once several reputation-weighted, independent reports agree, and every confirmation is anchored
          on-chain so the record can&apos;t quietly change later.{" "}
          <span className="text-[#64748b]">Currently running on BNB Chain Testnet.</span>
        </p>

        {loadError && <p className="text-red-400 text-sm mb-6">{loadError}</p>}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-10">
          <div className="bg-[#0a0f1e] border border-white/10 rounded-xl p-5">
            <div className="text-[#64748b] text-xs mb-1">Confirmed Threats</div>
            <div className="text-2xl font-bold text-[#f87171]">{stats ? stats.confirmedThreatsCount : "—"}</div>
          </div>
          <div className="bg-[#0a0f1e] border border-white/10 rounded-xl p-5">
            <div className="text-[#64748b] text-xs mb-1">Reporting Nodes</div>
            <div className="text-2xl font-bold">{stats ? stats.reportingNodesCount : "—"}</div>
          </div>
          <div className="bg-[#0a0f1e] border border-white/10 rounded-xl p-5">
            <div className="text-[#64748b] text-xs mb-1">Avg Node Reputation</div>
            <div className="text-2xl font-bold">{stats ? formatPct(stats.avgReputationBps) : "—"}</div>
          </div>
        </div>

        <div className="bg-[#090d16]/80 border border-white/5 rounded-xl p-6 mb-10">
          <h2 className="text-white font-bold text-sm mb-1">Check a destination</h2>
          <p className="text-[#64748b] text-xs mb-4">See whether a domain or IP has been reported and confirmed by the network.</p>
          <form onSubmit={handleCheck} className="flex flex-col sm:flex-row gap-3">
            <input
              value={checkInput}
              onChange={(e) => setCheckInput(e.target.value)}
              placeholder="e.g. example.com or an IP address"
              autoCapitalize="off"
              autoCorrect="off"
              className="flex-1 bg-black/30 border border-white/10 focus:border-[#00f2fe]/40 rounded-lg px-3 py-2.5 text-sm text-white outline-none"
            />
            <button
              type="submit"
              disabled={checking || !checkInput.trim()}
              className="bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black font-bold text-sm rounded-xl px-6 py-2.5 disabled:opacity-50 whitespace-nowrap"
            >
              {checking ? "Checking…" : "Check"}
            </button>
          </form>

          {checkResult && (
            <div className="mt-4 pt-4 border-t border-white/5">
              {checkResult.error ? (
                <p className="text-red-400 text-sm">{checkResult.error}</p>
              ) : !checkResult.known ? (
                <p className="text-[#94a3b8] text-sm">No recorded observations for this destination — that means nothing has been reported, not that it&apos;s confirmed safe.</p>
              ) : (
                <div>
                  <p className={`font-bold text-lg ${checkResult.statusLabel === "confirmed" ? "text-[#f87171]" : "text-[#94a3b8]"}`}>
                    {checkResult.statusLabel.toUpperCase()}
                  </p>
                  <p className="text-[#64748b] text-xs mt-1">
                    {CATEGORIES[checkResult.category] || "Unknown"} · {formatPct(checkResult.confidenceBps)} confidence ·{" "}
                    {(checkResult.contributingNodes || []).length} independent reporter(s)
                  </p>
                  {checkResult.onChainTxHash && (
                    <a
                      href={`https://testnet.bscscan.com/tx/${checkResult.onChainTxHash}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[#00f2fe] hover:underline text-xs mt-2 inline-block"
                    >
                      View on-chain confirmation ↗
                    </a>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div>
          <h2 className="text-white font-bold text-sm mb-3">Recently confirmed threats</h2>
          <div className="space-y-2">
            {feed.map((t) => (
              <div key={t._id} className="bg-[#090d16]/80 border border-white/5 rounded-xl p-4 flex items-center justify-between flex-wrap gap-2">
                <div>
                  <p className="text-white text-sm font-semibold">{t.indicator}</p>
                  <p className="text-[#64748b] text-[11px] font-mono mt-0.5">
                    {CATEGORIES[t.category] || "Unknown"} · {(t.contributingNodes || []).length} independent reporter(s)
                  </p>
                </div>
                <div className="text-right text-xs">
                  <p className="text-[#f87171] font-bold">{formatPct(t.confidenceBps)}</p>
                  <p className="text-[#64748b] font-mono text-[10px]">{formatDate(t.lastUpdated)}</p>
                </div>
              </div>
            ))}
            {feed.length === 0 && <p className="text-[#64748b] text-sm">No confirmed threats yet.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
