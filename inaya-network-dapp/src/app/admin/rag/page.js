"use client";

// app/admin/rag/page.js
//
// RAG infrastructure monitoring — same passphrase-gated session as every
// other /admin/* page (POST /api/admin/login sets inaya_admin_session;
// GET /api/admin/rag/stats re-checks it server-side). Read-only: shows
// what's indexed, retrieval health per assistant domain, and the
// "frequently unanswered questions" gap-finding signal, plus a manual
// re-ingest trigger. Honest-null convention throughout — a stat that
// couldn't be computed shows "Unavailable", never a fabricated 0.

import { useState, useCallback } from "react";

function formatDate(iso) {
  if (!iso) return "Never";
  return new Date(iso).toLocaleString();
}

function formatPct(value) {
  if (value === null || value === undefined) return "Unavailable";
  return `${value}%`;
}

export default function RagAdminPage() {
  const [passphrase, setPassphrase] = useState("");
  const [authed, setAuthed] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [loading, setLoading] = useState(false);

  const [stats, setStats] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [reingesting, setReingesting] = useState(false);
  const [reingestResult, setReingestResult] = useState(null);

  const loadStats = useCallback(async () => {
    setLoadError("");
    try {
      const res = await fetch("/api/admin/rag/stats");
      if (!res.ok) throw new Error("Session may have expired — please log in again.");
      setStats(await res.json());
    } catch (err) {
      setLoadError(err.message);
    }
  }, []);

  async function handleLogin(e) {
    e.preventDefault();
    setLoginError("");
    setLoading(true);
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passphrase }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setLoginError(data.error || "Login failed.");
        return;
      }
      setAuthed(true);
      await loadStats();
    } catch {
      setLoginError("Login failed.");
    } finally {
      setLoading(false);
    }
  }

  async function handleReingest() {
    setReingesting(true);
    setReingestResult(null);
    try {
      const res = await fetch("/api/admin/rag/reingest", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Re-ingestion failed.");
      setReingestResult(data);
      await loadStats();
    } catch (err) {
      setReingestResult({ error: err.message });
    } finally {
      setReingesting(false);
    }
  }

  if (!authed) {
    return (
      <div className="min-h-screen bg-[#060913] text-[#e2e8f0] font-sans flex items-center justify-center px-4">
        <form onSubmit={handleLogin} className="bg-[#090d16]/80 border border-white/5 rounded-xl p-8 w-full max-w-sm">
          <h1 className="text-lg font-extrabold text-white mb-1">RAG Infrastructure Admin</h1>
          <p className="text-[#94a3b8] text-xs mb-5">Enterprise Dashboard passphrase</p>
          <input
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder="Passphrase"
            className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-white mb-3"
            autoFocus
          />
          {loginError && <p className="text-red-400 text-xs mb-3">{loginError}</p>}
          <button disabled={loading} className="w-full py-2 rounded-lg text-xs font-bold uppercase bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40">
            {loading ? "Checking…" : "Sign in"}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#060913] text-[#e2e8f0] font-sans px-4 py-8 md:px-10">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-8 flex-wrap gap-3">
          <div>
            <h1 className="font-bold text-xl">RAG Infrastructure</h1>
            <p className="text-[#94a3b8] text-xs mt-1">Docs / Security / Learn retrieval health, last 7 days</p>
          </div>
          <div className="flex items-center gap-3">
            <a href="/admin" className="text-xs px-4 py-2 bg-white/5 border border-white/10 rounded-lg hover:bg-white/10">← Dashboard</a>
            <button onClick={handleReingest} disabled={reingesting} className="text-xs px-4 py-2 bg-[#00f2fe]/10 border border-[#00f2fe]/30 text-[#00f2fe] rounded-lg hover:bg-[#00f2fe]/20 disabled:opacity-40">
              {reingesting ? "Re-ingesting…" : "Re-ingest all sources"}
            </button>
          </div>
        </div>

        {reingestResult && (
          <div className={`mb-6 rounded-lg p-4 text-xs ${reingestResult.error ? "bg-red-400/10 border border-red-400/30 text-red-300" : "bg-emerald-400/10 border border-emerald-400/30 text-emerald-300"}`}>
            {reingestResult.error || `Re-ingested ${reingestResult.sources} sources: +${reingestResult.chunksAdded} added, ${reingestResult.chunksUpdated} updated, ${reingestResult.chunksRemoved} removed${reingestResult.errors ? `, ${reingestResult.errors} failed` : ""}.`}
          </div>
        )}

        {loadError && <p className="text-red-400 text-xs mb-4">{loadError}</p>}
        {!stats ? (
          <p className="text-[#94a3b8] text-sm">Loading…</p>
        ) : (
          <div className="space-y-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="bg-[#090d16]/80 border border-white/5 rounded-xl p-5">
                <p className="text-[#94a3b8] text-[11px] font-bold uppercase">Total indexed chunks</p>
                <p className="text-2xl font-extrabold mt-1">{stats.totalChunks}</p>
                <p className="text-[#8a96ab] text-[11px] mt-1 font-mono">
                  {Object.entries(stats.chunksByDomain).map(([d, c]) => `${d}: ${c}`).join(" · ") || "none yet"}
                </p>
              </div>
              <div className="bg-[#090d16]/80 border border-white/5 rounded-xl p-5">
                <p className="text-[#94a3b8] text-[11px] font-bold uppercase">Indexing failures (last 50 runs)</p>
                <p className="text-2xl font-extrabold mt-1">{stats.indexingFailures.length}</p>
              </div>
            </div>

            <div className="bg-[#090d16]/80 border border-white/5 rounded-xl p-5">
              <h3 className="text-xs font-bold uppercase text-[#94a3b8] mb-3">Retrieval by domain</h3>
              {stats.domainStats.length === 0 ? (
                <p className="text-[#8a96ab] text-xs italic">No retrieval activity in the last 7 days.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-[#8a96ab] text-left border-b border-white/5">
                        <th className="py-2 pr-4">Domain</th>
                        <th className="py-2 pr-4">Queries</th>
                        <th className="py-2 pr-4">Success rate</th>
                        <th className="py-2 pr-4">No result</th>
                        <th className="py-2 pr-4">Low relevance</th>
                        <th className="py-2 pr-4">Avg latency</th>
                        <th className="py-2 pr-4">P95 latency</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.domainStats.map((d) => (
                        <tr key={d.domain} className="border-b border-white/5 last:border-0">
                          <td className="py-2 pr-4 font-bold">{d.domain}</td>
                          <td className="py-2 pr-4">{d.totalQueries}</td>
                          <td className="py-2 pr-4">{formatPct(d.successRate)}</td>
                          <td className="py-2 pr-4">{d.noResultCount}</td>
                          <td className="py-2 pr-4">{d.belowThresholdCount}</td>
                          <td className="py-2 pr-4">{d.avgLatencyMs != null ? `${d.avgLatencyMs}ms` : "Unavailable"}</td>
                          <td className="py-2 pr-4">{d.p95LatencyMs != null ? `${d.p95LatencyMs}ms` : "Unavailable"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="bg-[#090d16]/80 border border-white/5 rounded-xl p-5">
              <h3 className="text-xs font-bold uppercase text-[#94a3b8] mb-3">Frequently unanswered questions</h3>
              {stats.frequentlyUnanswered.length === 0 ? (
                <p className="text-[#8a96ab] text-xs italic">None in the last 7 days.</p>
              ) : (
                <div className="space-y-1.5">
                  {stats.frequentlyUnanswered.map((item, i) => (
                    <div key={i} className="flex items-center justify-between gap-3 text-xs">
                      <span className="text-slate-300 truncate">{item.query}</span>
                      <span className="text-[#8a96ab] font-mono shrink-0">×{item.count}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="bg-[#090d16]/80 border border-white/5 rounded-xl p-5">
              <h3 className="text-xs font-bold uppercase text-[#94a3b8] mb-3">Source freshness</h3>
              {stats.sourceFreshness.length === 0 ? (
                <p className="text-[#8a96ab] text-xs italic">No sources ingested yet — click "Re-ingest all sources" above.</p>
              ) : (
                <div className="space-y-1.5">
                  {stats.sourceFreshness.map((s) => (
                    <div key={s.sourceId} className="flex items-center justify-between gap-3 text-xs">
                      <span className="text-slate-300 font-mono truncate">{s.sourceId}</span>
                      <span className="text-[#8a96ab] shrink-0">{s.chunkCount ?? 0} chunks · {formatDate(s.lastIngestedAt)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {stats.indexingFailures.length > 0 && (
              <div className="bg-red-400/5 border border-red-400/20 rounded-xl p-5">
                <h3 className="text-xs font-bold uppercase text-red-300 mb-3">Recent indexing failures</h3>
                <div className="space-y-1.5">
                  {stats.indexingFailures.map((f, i) => (
                    <div key={i} className="text-xs">
                      <span className="text-slate-300 font-mono">{f.sourceId}</span>
                      <span className="text-red-300"> — {f.error}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
