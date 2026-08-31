"use client";

// app/admin/audit/page.js
//
// Cryptographic Audit Trail admin dashboard (Phase 2) — same passphrase-
// gated session as every other /admin/* page. Chain browser for one org
// at a time (orgId is looked up manually — there's no cross-org listing
// UI anywhere else in /admin either), an "Integrity: Verified" / "Break
// at seq N" banner from GET /api/admin/audit's live verifyChainIntegrity()
// call, and a Download CSV/JSON button hitting the export route.

import { useState, useCallback } from "react";

function formatDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

export default function AuditAdminPage() {
  const [passphrase, setPassphrase] = useState("");
  const [authed, setAuthed] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [loading, setLoading] = useState(false);

  const [orgId, setOrgId] = useState("");
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [loadingChain, setLoadingChain] = useState(false);

  const loadChain = useCallback(async (id) => {
    if (!id.trim()) return;
    setLoadingChain(true);
    setLoadError("");
    try {
      const res = await fetch(`/api/admin/audit?orgId=${encodeURIComponent(id.trim())}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not load audit chain.");
      setData(json);
    } catch (err) {
      setData(null);
      setLoadError(err.message);
    } finally {
      setLoadingChain(false);
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
        const json = await res.json().catch(() => ({}));
        setLoginError(json.error || "Login failed.");
        return;
      }
      setAuthed(true);
      setPassphrase("");
    } catch {
      setLoginError("Login failed.");
    } finally {
      setLoading(false);
    }
  }

  if (!authed) {
    return (
      <div className="min-h-screen bg-[#060913] text-[#e2e8f0] font-sans flex items-center justify-center px-4">
        <form onSubmit={handleLogin} className="bg-[#090d16]/80 border border-white/5 rounded-xl p-8 w-full max-w-sm">
          <h1 className="text-lg font-extrabold text-white mb-1">Cryptographic Audit Trail</h1>
          <p className="text-[#94a3b8] text-xs mb-5">Enterprise Dashboard passphrase</p>
          <input
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            className="w-full bg-black/30 border border-white/10 focus:border-[#00f2fe]/40 rounded-lg px-3 py-2.5 text-sm text-white outline-none mb-3"
            placeholder="Passphrase"
            autoFocus
          />
          {loginError && <p className="text-red-400 text-xs mb-3">{loginError}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black font-bold text-sm rounded-xl px-4 py-2.5 disabled:opacity-50"
          >
            {loading ? "Checking…" : "Sign in"}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#060913] text-[#e2e8f0] font-sans px-4 py-10 md:px-10">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-extrabold text-white">Cryptographic Audit Trail</h1>
            <p className="text-[#8a96ab] text-xs mt-0.5">
              Hash-chained overlay over every Business Workspace activity + document event. Look up one org by ID to browse its chain and verify it hasn't been tampered with.
            </p>
          </div>
          <a href="/admin" className="text-xs px-4 py-2 bg-white/5 border border-white/10 rounded-lg hover:bg-white/10">
            ← Dashboard
          </a>
        </div>

        <form onSubmit={(e) => { e.preventDefault(); loadChain(orgId); }} className="flex items-center gap-2 mb-6">
          <input
            value={orgId}
            onChange={(e) => setOrgId(e.target.value)}
            placeholder="Org ID"
            className="flex-1 max-w-sm bg-black/30 border border-white/10 focus:border-[#00f2fe]/40 rounded-lg px-3 py-2.5 text-sm text-white outline-none font-mono"
          />
          <button type="submit" disabled={loadingChain || !orgId.trim()} className="text-xs font-bold uppercase px-4 py-2.5 rounded-lg bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40">
            {loadingChain ? "Loading…" : "Load chain"}
          </button>
          {data && (
            <>
              <a href={`/api/admin/audit/export?orgId=${encodeURIComponent(orgId.trim())}&format=csv`} className="text-xs px-4 py-2.5 bg-white/5 border border-white/10 rounded-lg hover:bg-white/10">
                ↓ CSV
              </a>
              <a href={`/api/admin/audit/export?orgId=${encodeURIComponent(orgId.trim())}&format=json`} className="text-xs px-4 py-2.5 bg-white/5 border border-white/10 rounded-lg hover:bg-white/10">
                ↓ JSON
              </a>
            </>
          )}
        </form>

        {loadError && <p className="text-red-400 text-sm mb-4">{loadError}</p>}

        {data && (
          <>
            <div className={`mb-6 rounded-xl border px-4 py-3 text-sm font-bold ${data.integrity.valid ? "bg-emerald-400/10 text-emerald-400 border-emerald-400/30" : "bg-red-400/10 text-red-400 border-red-400/30"}`}>
              {data.integrity.valid
                ? `✓ Verified — ${data.integrity.count} entries, chain intact.`
                : `⚠ Break at seq ${data.integrity.brokenAtSeq} — ${data.integrity.reason}`}
            </div>

            <div className="bg-[#0a0f1e] border border-white/10 rounded-xl overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[#8a96ab] uppercase border-b border-white/10">
                    <th className="px-4 py-3">Seq</th>
                    <th className="px-4 py-3">Type</th>
                    <th className="px-4 py-3">Action</th>
                    <th className="px-4 py-3">State</th>
                    <th className="px-4 py-3">Actor</th>
                    <th className="px-4 py-3">Entry Hash</th>
                    <th className="px-4 py-3">When</th>
                  </tr>
                </thead>
                <tbody>
                  {data.entries.map((e) => (
                    <tr key={e.eventId} className="border-b border-white/5 last:border-0">
                      <td className="px-4 py-3 font-mono">{e.seq}</td>
                      <td className="px-4 py-3 text-[#94a3b8]">{e.recordType}</td>
                      <td className="px-4 py-3">{e.action}</td>
                      <td className="px-4 py-3 text-[#94a3b8] font-mono">{e.previousState && e.newState ? `${e.previousState} → ${e.newState}` : "—"}</td>
                      <td className="px-4 py-3 text-[#94a3b8] truncate max-w-[160px]">{e.actorEmail || "—"}</td>
                      <td className="px-4 py-3 font-mono text-[#8a96ab] truncate max-w-[120px]">{e.entryHash.slice(0, 16)}…</td>
                      <td className="px-4 py-3 text-[#8a96ab] font-mono">{formatDate(e.timestamp)}</td>
                    </tr>
                  ))}
                  {data.entries.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-4 py-6 text-center text-[#8a96ab]">No chain entries recorded yet for this org.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
