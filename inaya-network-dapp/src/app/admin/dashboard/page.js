"use client";

// app/admin/dashboard/page.js
//
// Private owner-only dashboard — not linked from anywhere on the public
// site. Visit as /admin/dashboard?key=YOUR_SECRET (the same value as
// ADMIN_DASHBOARD_SECRET, set in Vercel's env vars). Bookmark the full URL
// with the key included; there's no login form, this is a one-person view.

import { useState, useEffect } from "react";

function Bar({ value, max, color }) {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <div className="w-full h-1.5 bg-white/5 rounded-full overflow-hidden">
      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

export default function AdminDashboardPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const key = new URLSearchParams(window.location.search).get("key") || "";
    fetch(`/api/admin/dashboard?key=${encodeURIComponent(key)}`)
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
        setData(json);
      })
      .catch((err) => setError(err.message));
  }, []);

  if (error) {
    return (
      <div className="min-h-screen bg-[#060913] text-[#e2e8f0] font-mono flex items-center justify-center p-6">
        <p className="text-red-400 text-sm">⚠ {error}{error === "Unauthorized" ? " — append ?key=YOUR_SECRET to the URL." : ""}</p>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="min-h-screen bg-[#060913] text-[#e2e8f0] font-mono flex items-center justify-center">
        <p className="text-[#94a3b8] text-sm">Loading…</p>
      </div>
    );
  }

  const maxReferrals = Math.max(1, ...data.referrers.map((r) => r.referrals));
  const maxPoints = Math.max(1, ...data.watchers.map((w) => w.points));
  const activeCount = data.watchers.filter((w) => w.active).length;

  return (
    <div className="min-h-screen bg-[#060913] text-[#e2e8f0] font-sans px-4 py-10 md:px-10">
      <div className="max-w-5xl mx-auto space-y-10">
        <div>
          <h1 className="text-2xl font-extrabold text-white">Admin Dashboard</h1>
          <p className="text-[#64748b] text-xs font-mono mt-1">Private view — not linked publicly.</p>
        </div>

        {/* CHART 1: Referrals by email */}
        <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6">
          <div className="flex items-baseline justify-between mb-4">
            <h2 className="text-sm font-bold text-white">Referrals by Email</h2>
            <span className="text-[10px] text-[#64748b] font-mono">{data.referrers.length} referrers</span>
          </div>
          {data.referrers.length === 0 ? (
            <p className="text-[#64748b] text-xs italic">No referrers yet.</p>
          ) : (
            <div className="space-y-3">
              {data.referrers.map((r) => (
                <div key={r.email} className="grid grid-cols-[1fr_auto] gap-3 items-center">
                  <div>
                    <div className="flex items-baseline justify-between text-xs mb-1">
                      <span className="font-mono text-slate-300 truncate">{r.email}</span>
                      <span className="font-mono font-bold text-[#00f2fe] ml-3 shrink-0">{r.referrals}</span>
                    </div>
                    <Bar value={r.referrals} max={maxReferrals} color="#00f2fe" />
                  </div>
                  <span className="text-[9px] font-bold uppercase tracking-wide text-[#64748b] w-16 text-right">{r.status}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* CHART 2: Watcher Pioneer wallets */}
        <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6">
          <div className="flex items-baseline justify-between mb-4">
            <h2 className="text-sm font-bold text-white">Watcher Pioneer Wallets</h2>
            <span className="text-[10px] text-[#64748b] font-mono">{data.watchers.length} enrolled · {activeCount} active now</span>
          </div>
          {data.watchers.length === 0 ? (
            <p className="text-[#64748b] text-xs italic">No enrolled wallets yet.</p>
          ) : (
            <div className="space-y-3">
              {data.watchers.map((w) => (
                <div key={w.walletAddress} className="grid grid-cols-[1fr_auto_auto] gap-3 items-center">
                  <div>
                    <div className="flex items-baseline justify-between text-xs mb-1">
                      <span className="font-mono text-slate-300 truncate">{w.walletAddress}</span>
                      <span className="font-mono ml-3 shrink-0">
                        <span className="font-bold text-emerald-400">{w.points.toLocaleString()} pts</span>
                        <span className="text-[#64748b]"> · {w.inaya.toFixed(2)} INAYA</span>
                      </span>
                    </div>
                    <Bar value={w.points} max={maxPoints} color="#34d399" />
                  </div>
                  <span
                    className={`text-[9px] font-bold uppercase tracking-wide px-2 py-1 rounded-full border text-center ${
                      w.active
                        ? "bg-emerald-400/10 text-emerald-400 border-emerald-400/30"
                        : "bg-white/5 text-[#64748b] border-white/10"
                    }`}
                  >
                    {w.active ? "Active" : "Inactive"}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
