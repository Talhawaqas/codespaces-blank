"use client";

// app/automation/page.js
//
// Public Oracle & Automation Layer transparency page — no wallet, no
// login, same pattern as /security. Every number here is read live from
// the 3 deployed contracts (api/automation/status/route.js), not a
// database snapshot -- reload the page and you're looking at the chain's
// current state.

import { useState, useEffect, useCallback } from "react";

function formatDate(iso) {
  if (!iso) return "Never";
  return new Date(iso).toLocaleString();
}

function shortAddr(addr) {
  if (!addr) return "—";
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

function formatFixed18(rawValue) {
  const n = Number(rawValue) / 1e18;
  return n.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 6 });
}

export default function AutomationTransparencyPage() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const res = await fetch("/api/automation/status");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load status.");
      setStatus(data);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="relative min-h-screen bg-[#060913] text-[#e2e8f0] font-sans px-4 py-16 md:px-10 overflow-hidden">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-24 -left-24 w-96 h-96 rounded-full bg-[#00f2fe]/10 blur-[120px]" />
        <div className="absolute -bottom-32 -right-24 w-[28rem] h-[28rem] rounded-full bg-violet-500/10 blur-[130px]" />
      </div>

      <div className="relative max-w-5xl mx-auto">
        <a href="/" className="inline-flex items-center gap-2 text-[#8a96ab] hover:text-[#00f2fe] text-xs font-mono mb-8 transition-colors">
          ← Back to Inaya Network
        </a>

        <span className="inline-block text-[10px] font-mono font-bold tracking-widest text-[#00f2fe] bg-cyan-500/10 border border-[#00f2fe]/30 rounded-full px-3 py-1 mb-4">
          ORACLE &amp; AUTOMATION
        </span>
        <h1 className="text-3xl sm:text-4xl font-black text-white tracking-tight mb-3">Oracle &amp; Automation Status</h1>
        <p className="text-[#94a3b8] text-base mb-2 max-w-2xl">
          Live on-chain data feeding Inaya's contracts, and the self-operating tasks running against them — every number below is read directly from BSC Testnet, not a cached snapshot.
        </p>
        <div className="inline-flex items-center gap-2 text-[11px] font-mono bg-amber-400/10 border border-amber-400/30 text-amber-300 rounded-full px-3 py-1 mb-10">
          🧪 BSC Testnet only — no real-value automation enabled
        </div>

        {error && <p className="text-red-400 text-sm mb-6">{error}</p>}
        {!status && !error && <p className="text-[#8a96ab] text-sm">Loading…</p>}

        {status && (
          <>
            <section className="mb-10">
              <h2 className="text-[#00f2fe] font-mono text-xs font-bold tracking-widest uppercase mb-3">Contracts</h2>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {[
                  ["Oracle Registry", status.contracts.oracleRegistry],
                  ["Oracle Adapter", status.contracts.oracleAdapter],
                  ["Automation Registry", status.contracts.automationRegistry],
                ].map(([label, addr]) => (
                  <a
                    key={label}
                    href={`https://testnet.bscscan.com/address/${addr}`}
                    target="_blank"
                    rel="noreferrer"
                    className="bg-[#090d16]/80 border border-white/5 hover:border-[#00f2fe]/30 rounded-xl p-4 transition-colors"
                  >
                    <p className="text-[#8a96ab] text-[10px] uppercase font-bold mb-1">{label}</p>
                    <p className="text-[#00f2fe] text-xs font-mono break-all">{shortAddr(addr)} ↗</p>
                  </a>
                ))}
              </div>
            </section>

            <section className="mb-10">
              <h2 className="text-[#00f2fe] font-mono text-xs font-bold tracking-widest uppercase mb-3">
                Oracle Sources ({status.sources.length})
              </h2>
              <div className="space-y-3">
                {status.sources.map((s) => (
                  <div key={s.id} className="bg-[#090d16]/80 border border-white/5 rounded-xl p-5">
                    <div className="flex items-start justify-between flex-wrap gap-3">
                      <div>
                        <p className="text-white font-bold text-sm">{s.dataType}</p>
                        <p className="text-[#8a96ab] text-[11px] font-mono mt-0.5">Submitter: {shortAddr(s.submitter)} · updates every {s.updateFrequencySeconds}s min</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={`text-[10px] font-bold uppercase px-2 py-1 rounded-full border ${s.active ? "text-emerald-400 border-emerald-400/30 bg-emerald-400/10" : "text-[#8a96ab] border-white/10 bg-white/5"}`}>
                          {s.active ? "Active" : "Inactive"}
                        </span>
                        <span className={`text-[10px] font-bold uppercase px-2 py-1 rounded-full border ${s.stale ? "text-red-400 border-red-400/30 bg-red-400/10" : "text-emerald-400 border-emerald-400/30 bg-emerald-400/10"}`}>
                          {s.stale ? "Stale" : "Fresh"}
                        </span>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-4 font-mono text-xs">
                      <div>
                        <p className="text-[#8a96ab] text-[10px] uppercase mb-0.5">Latest Value</p>
                        <p className="text-[#00f2fe] font-bold">{formatFixed18(s.latestValue)}</p>
                      </div>
                      <div>
                        <p className="text-[#8a96ab] text-[10px] uppercase mb-0.5">Last Update</p>
                        <p className="text-slate-300">{formatDate(s.lastUpdate)}</p>
                      </div>
                      <div>
                        <p className="text-[#8a96ab] text-[10px] uppercase mb-0.5">Max Staleness</p>
                        <p className="text-slate-300">{status.maxStalenessSeconds}s</p>
                      </div>
                    </div>
                  </div>
                ))}
                {status.sources.length === 0 && <p className="text-[#8a96ab] text-sm">No oracle sources registered yet.</p>}
              </div>
            </section>

            <section>
              <h2 className="text-[#00f2fe] font-mono text-xs font-bold tracking-widest uppercase mb-3">
                Automation Tasks ({status.tasks.length})
              </h2>
              <div className="space-y-3">
                {status.tasks.map((t) => (
                  <div key={t.id} className="bg-[#090d16]/80 border border-white/5 rounded-xl p-5">
                    <div className="flex items-start justify-between flex-wrap gap-3">
                      <div>
                        <p className="text-white font-bold text-sm">{t.conditionDescription}</p>
                        <a
                          href={`https://testnet.bscscan.com/address/${t.targetContract}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[#8a96ab] hover:text-[#00f2fe] text-[11px] font-mono mt-0.5 inline-block"
                        >
                          Target: {shortAddr(t.targetContract)} ↗
                        </a>
                      </div>
                      <span className={`text-[10px] font-bold uppercase px-2 py-1 rounded-full border shrink-0 ${t.active ? "text-emerald-400 border-emerald-400/30 bg-emerald-400/10" : "text-[#8a96ab] border-white/10 bg-white/5"}`}>
                        {t.active ? "Active" : "Inactive"}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-4 font-mono text-xs">
                      <div>
                        <p className="text-[#8a96ab] text-[10px] uppercase mb-0.5">Last Execution</p>
                        <p className="text-slate-300">{formatDate(t.lastExecution)}</p>
                      </div>
                      <div>
                        <p className="text-[#8a96ab] text-[10px] uppercase mb-0.5">Next Eligible Check</p>
                        <p className="text-slate-300">{formatDate(t.nextEligible)}</p>
                      </div>
                      <div>
                        <p className="text-[#8a96ab] text-[10px] uppercase mb-0.5">Consecutive Failures</p>
                        <p className={t.consecutiveFailures > 0 ? "text-amber-400 font-bold" : "text-emerald-400"}>{t.consecutiveFailures}</p>
                      </div>
                    </div>
                  </div>
                ))}
                {status.tasks.length === 0 && <p className="text-[#8a96ab] text-sm">No automation tasks registered yet.</p>}
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
