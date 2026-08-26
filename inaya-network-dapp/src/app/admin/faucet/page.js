"use client";

// app/admin/faucet/page.js
//
// Faucet request tracking dashboard — same passphrase-gated session as
// every other /admin/* page. Read-only: shows what src/lib/faucet.js's
// recordFaucetRequest() has recorded. Search by wallet address to see
// that address's full request history.

import { useState, useEffect, useCallback } from "react";

function formatDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

export default function FaucetAdminPage() {
  const [passphrase, setPassphrase] = useState("");
  const [authed, setAuthed] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [loading, setLoading] = useState(false);

  const [items, setItems] = useState([]);
  const [stats, setStats] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [walletFilter, setWalletFilter] = useState("");

  const loadData = useCallback(async (wallet) => {
    setLoadError("");
    try {
      const query = wallet ? `?wallet=${encodeURIComponent(wallet)}` : "";
      const [requestsRes, statsRes] = await Promise.all([
        fetch(`/api/admin/faucet/requests${query}`),
        fetch("/api/admin/faucet/stats"),
      ]);
      if (!requestsRes.ok || !statsRes.ok) throw new Error("Session may have expired — please log in again.");
      setItems((await requestsRes.json()).items);
      setStats(await statsRes.json());
    } catch (err) {
      setLoadError(err.message);
    }
  }, []);

  useEffect(() => {
    if (authed) loadData();
  }, [authed, loadData]);

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
      setPassphrase("");
    } catch {
      setLoginError("Login failed.");
    } finally {
      setLoading(false);
    }
  }

  function handleWalletSearch(e) {
    e.preventDefault();
    loadData(walletFilter.trim() || undefined);
  }

  if (!authed) {
    return (
      <div className="min-h-screen bg-[#060913] text-[#e2e8f0] font-sans flex items-center justify-center px-4">
        <form onSubmit={handleLogin} className="bg-[#090d16]/80 border border-white/5 rounded-xl p-8 w-full max-w-sm">
          <h1 className="text-lg font-extrabold text-white mb-1">Faucet Tracking</h1>
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
            <h1 className="text-2xl font-extrabold text-white">Faucet Tracking</h1>
            <p className="text-[#8a96ab] text-xs mt-0.5">Every testnet token request, by wallet address.</p>
          </div>
          <div className="flex items-center gap-2">
            <a href="/admin" className="text-xs px-4 py-2 bg-white/5 border border-white/10 rounded-lg hover:bg-white/10">
              ← Dashboard
            </a>
            <button onClick={() => loadData(walletFilter.trim() || undefined)} className="text-xs px-4 py-2 bg-white/5 border border-white/10 rounded-lg hover:bg-white/10">
              Refresh
            </button>
          </div>
        </div>

        {loadError && <p className="text-red-400 text-sm mb-4">{loadError}</p>}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
          <div className="bg-[#0a0f1e] border border-white/10 rounded-xl p-5">
            <div className="text-[#8a96ab] text-xs mb-1">Total Requests</div>
            <div className="text-2xl font-bold">{stats?.total ?? "—"}</div>
          </div>
          <div className="bg-[#0a0f1e] border border-white/10 rounded-xl p-5">
            <div className="text-[#8a96ab] text-xs mb-1">Last 24h</div>
            <div className="text-2xl font-bold text-[#00f2fe]">{stats?.last24h ?? "—"}</div>
          </div>
          <div className="bg-[#0a0f1e] border border-white/10 rounded-xl p-5">
            <div className="text-[#8a96ab] text-xs mb-1">Unique Wallets</div>
            <div className="text-2xl font-bold">{stats?.uniqueWallets ?? "—"}</div>
          </div>
        </div>

        <form onSubmit={handleWalletSearch} className="flex gap-2 mb-6">
          <input
            type="text"
            value={walletFilter}
            onChange={(e) => setWalletFilter(e.target.value)}
            placeholder="Search by wallet address (0x...)"
            className="flex-1 bg-[#0a0f1e] border border-white/10 focus:border-[#00f2fe]/40 rounded-lg px-3 py-2 text-sm text-white outline-none font-mono"
          />
          <button type="submit" className="text-xs px-4 py-2 bg-white/5 border border-white/10 rounded-lg hover:bg-white/10">
            Search
          </button>
          {walletFilter && (
            <button
              type="button"
              onClick={() => { setWalletFilter(""); loadData(); }}
              className="text-xs px-4 py-2 bg-white/5 border border-white/10 rounded-lg hover:bg-white/10"
            >
              Clear
            </button>
          )}
        </form>

        <div className="bg-[#0a0f1e] border border-white/10 rounded-xl overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[#8a96ab] uppercase border-b border-white/10">
                <th className="px-4 py-3">Wallet</th>
                <th className="px-4 py-3">IP</th>
                <th className="px-4 py-3">$INAYA</th>
                <th className="px-4 py-3">mUSDT</th>
                <th className="px-4 py-3">When</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id} className="border-b border-white/5 last:border-0">
                  <td className="px-4 py-3 font-mono truncate max-w-[180px]">{r.walletAddress}</td>
                  <td className="px-4 py-3 font-mono text-[#94a3b8]">{r.ipAddress}</td>
                  <td className="px-4 py-3">
                    {r.inayaSent ? <span className="text-emerald-400">+{r.inayaAmount}</span> : <span className="text-[#8a96ab]">skipped</span>}
                  </td>
                  <td className="px-4 py-3">
                    {r.usdtSent ? <span className="text-emerald-400">+{r.usdtAmount}</span> : <span className="text-[#8a96ab]">skipped</span>}
                  </td>
                  <td className="px-4 py-3 text-[#8a96ab] font-mono">{formatDate(r.createdAt)}</td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-[#8a96ab]">No faucet requests recorded yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
