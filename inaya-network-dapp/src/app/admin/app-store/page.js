"use client";

// app/admin/app-store/page.js
//
// Community App Store review queue — same passphrase-gated session as
// every other /admin/* page (mirrors admin/audit/page.js's login flow
// exactly). Each pending submission shows its threatCheck result from
// submission time right in the queue, so a reviewer sees the security
// signal before opening anything. Approve/reject re-runs the threat check
// server-side at review time too (reviewAppListing()) — this page just
// displays whatever came back, it doesn't decide anything itself.

import { useState, useCallback, useEffect } from "react";

export default function AppStoreAdminPage() {
  const [passphrase, setPassphrase] = useState("");
  const [authed, setAuthed] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [loading, setLoading] = useState(false);

  const [listings, setListings] = useState(null);
  const [error, setError] = useState("");
  const [acting, setActing] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/app-store/pending");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load pending listings.");
      setListings(data.listings);
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => { if (authed) load(); }, [authed, load]);

  async function handleLogin(e) {
    e.preventDefault();
    setLoginError("");
    setLoading(true);
    try {
      const res = await fetch("/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ passphrase }) });
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

  async function review(slug, decision) {
    setActing(slug + decision);
    setError("");
    try {
      const res = await fetch(`/api/admin/app-store/${slug}/review`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Review failed.");
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setActing("");
    }
  }

  if (!authed) {
    return (
      <div className="min-h-screen bg-[#060913] text-[#e2e8f0] font-sans flex items-center justify-center px-4">
        <form onSubmit={handleLogin} className="bg-[#090d16]/80 border border-white/5 rounded-xl p-8 w-full max-w-sm">
          <h1 className="text-lg font-extrabold text-white mb-1">App Store Review Queue</h1>
          <p className="text-[#94a3b8] text-xs mb-5">Enterprise Dashboard passphrase</p>
          <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} className="w-full bg-black/30 border border-white/10 focus:border-[#00f2fe]/40 rounded-lg px-3 py-2.5 text-sm text-white outline-none mb-3" placeholder="Passphrase" autoFocus />
          {loginError && <p className="text-red-400 text-xs mb-3">{loginError}</p>}
          <button type="submit" disabled={loading} className="w-full bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black font-bold text-sm rounded-xl px-4 py-2.5 disabled:opacity-50">
            {loading ? "Checking…" : "Sign in"}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#060913] text-[#e2e8f0] font-sans px-4 py-10 md:px-10">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-extrabold text-white">App Store Review Queue</h1>
            <p className="text-[#8a96ab] text-xs mt-0.5">Nothing here is public until approved. Every entry's Security Layer check ran at submission time.</p>
          </div>
          <a href="/admin" className="text-xs px-4 py-2 bg-white/5 border border-white/10 rounded-lg hover:bg-white/10">← Dashboard</a>
        </div>

        {error && <p className="text-red-400 text-sm mb-4">{error}</p>}

        {!listings ? (
          <p className="text-[#8a96ab] text-sm">Loading…</p>
        ) : listings.length === 0 ? (
          <p className="text-[#8a96ab] text-sm">Nothing pending review.</p>
        ) : (
          <div className="space-y-3">
            {listings.map((l) => (
              <div key={l.slug} className="bg-[#0a0f1e] border border-white/10 rounded-xl p-5">
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="min-w-0">
                    <p className="text-white font-bold text-sm">{l.name} <span className="text-[#5b6472] font-normal text-xs">· {l.category}</span></p>
                    <p className="text-[#94a3b8] text-xs mt-1 max-w-xl">{l.description}</p>
                    <p className="text-[#5b6472] text-[11px] font-mono mt-2">
                      {l.hostType === "ipfs" ? `IPFS: ${l.cid}` : `URL: ${l.embedUrl}`} · Submitted by {l.submitterAddress}
                    </p>
                    <div className="mt-2">
                      {l.threatCheck?.known && l.threatCheck.statusLabel === "confirmed" ? (
                        <span className="text-[11px] font-bold text-red-400 bg-red-400/10 border border-red-400/30 rounded-full px-2 py-0.5">⚠️ CONFIRMED threat on file for {l.threatCheck.indicator}</span>
                      ) : l.threatCheck?.known ? (
                        <span className="text-[11px] font-bold text-amber-400 bg-amber-400/10 border border-amber-400/30 rounded-full px-2 py-0.5">❔ {l.threatCheck.statusLabel} report on file</span>
                      ) : (
                        <span className="text-[11px] font-bold text-[#5b6472] bg-white/5 border border-white/10 rounded-full px-2 py-0.5">No threat report on file</span>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button onClick={() => review(l.slug, "approve")} disabled={!!acting} className="text-xs font-bold uppercase px-3 py-1.5 rounded-lg bg-emerald-400/10 text-emerald-400 border border-emerald-400/30 disabled:opacity-40">
                      {acting === l.slug + "approve" ? "…" : "Approve"}
                    </button>
                    <button onClick={() => review(l.slug, "reject")} disabled={!!acting} className="text-xs font-bold uppercase px-3 py-1.5 rounded-lg bg-red-400/10 text-red-400 border border-red-400/30 disabled:opacity-40">
                      {acting === l.slug + "reject" ? "…" : "Reject"}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
