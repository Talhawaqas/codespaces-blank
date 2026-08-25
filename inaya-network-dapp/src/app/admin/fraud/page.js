"use client";

// app/admin/fraud/page.js
//
// Fraud & Abuse Protection Layer admin dashboard (SOW section 6) — same
// passphrase-gated session as every other /admin/* page. Read-only: this
// page shows what src/lib/fraudRisk.js's assessRisk() has recorded so far.
// Nothing here enforces anything yet (Phase 2, not built this pass) —
// see the module comment at the top of fraudRisk.js.

import { useState, useEffect, useCallback } from "react";

const CLASSIFICATION_LABELS = {
  VPN_DETECTED: "VPN",
  PROXY_DETECTED: "Proxy",
  TOR_DETECTED: "Tor",
  DATACENTER_IP: "Datacenter",
  RESIDENTIAL_IP: "Residential",
  UNKNOWN: "Unknown",
};
const LEVEL_COLORS = {
  LOW: "text-emerald-400 border-emerald-400/30 bg-emerald-400/10",
  MEDIUM: "text-amber-400 border-amber-400/30 bg-amber-400/10",
  HIGH: "text-red-400 border-red-400/30 bg-red-400/10",
};
const ACTION_COLORS = {
  ALLOW: "text-emerald-400",
  MONITOR: "text-[#00f2fe]",
  VERIFY: "text-amber-400",
  RESTRICT: "text-orange-400",
  TEMPORARILY_BLOCK: "text-red-400",
};

function formatDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

export default function FraudAdminPage() {
  const [passphrase, setPassphrase] = useState("");
  const [authed, setAuthed] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [loading, setLoading] = useState(false);

  const [items, setItems] = useState([]);
  const [stats, setStats] = useState(null);
  const [loadError, setLoadError] = useState("");

  const loadData = useCallback(async () => {
    setLoadError("");
    try {
      const [assessmentsRes, statsRes] = await Promise.all([
        fetch("/api/admin/fraud/assessments"),
        fetch("/api/admin/fraud/stats"),
      ]);
      if (!assessmentsRes.ok || !statsRes.ok) throw new Error("Session may have expired — please log in again.");
      setItems((await assessmentsRes.json()).items);
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

  if (!authed) {
    return (
      <div className="min-h-screen bg-[#060913] text-[#e2e8f0] font-sans flex items-center justify-center px-4">
        <form onSubmit={handleLogin} className="bg-[#090d16]/80 border border-white/5 rounded-xl p-8 w-full max-w-sm">
          <h1 className="text-lg font-extrabold text-white mb-1">Fraud &amp; Abuse Protection</h1>
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
            <h1 className="text-2xl font-extrabold text-white">Fraud &amp; Abuse Protection</h1>
            <p className="text-[#8a96ab] text-xs mt-0.5">Detection only — nothing here enforces anything yet (Phase 2).</p>
          </div>
          <div className="flex items-center gap-2">
            <a href="/admin" className="text-xs px-4 py-2 bg-white/5 border border-white/10 rounded-lg hover:bg-white/10">
              ← Dashboard
            </a>
            <button onClick={loadData} className="text-xs px-4 py-2 bg-white/5 border border-white/10 rounded-lg hover:bg-white/10">
              Refresh
            </button>
          </div>
        </div>

        {loadError && <p className="text-red-400 text-sm mb-4">{loadError}</p>}

        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 mb-6">
          <div className="bg-[#0a0f1e] border border-white/10 rounded-xl p-5">
            <div className="text-[#8a96ab] text-xs mb-1">Total Assessments</div>
            <div className="text-2xl font-bold">{stats?.total ?? "—"}</div>
          </div>
          {["LOW", "MEDIUM", "HIGH"].map((level) => (
            <div key={level} className="bg-[#0a0f1e] border border-white/10 rounded-xl p-5">
              <div className="text-[#8a96ab] text-xs mb-1">{level} Risk</div>
              <div className={`text-2xl font-bold ${LEVEL_COLORS[level].split(" ")[0]}`}>{stats?.byLevel?.[level] ?? 0}</div>
            </div>
          ))}
        </div>

        <div className="flex flex-wrap gap-2 mb-6">
          {Object.entries(CLASSIFICATION_LABELS).map(([key, label]) => (
            <span key={key} className="text-[10px] font-mono px-3 py-1.5 rounded-full bg-white/5 border border-white/10 text-[#94a3b8]">
              {label}: {stats?.byClassification?.[key] ?? 0}
            </span>
          ))}
        </div>

        <div className="bg-[#0a0f1e] border border-white/10 rounded-xl overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[#8a96ab] uppercase border-b border-white/10">
                <th className="px-4 py-3">IP</th>
                <th className="px-4 py-3">Classification</th>
                <th className="px-4 py-3">Reputation</th>
                <th className="px-4 py-3">Score</th>
                <th className="px-4 py-3">Level</th>
                <th className="px-4 py-3">Action</th>
                <th className="px-4 py-3">Surface</th>
                <th className="px-4 py-3">Identity</th>
                <th className="px-4 py-3">When</th>
              </tr>
            </thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.id} className="border-b border-white/5 last:border-0">
                  <td className="px-4 py-3 font-mono">{a.ipAddress}</td>
                  <td className="px-4 py-3">{CLASSIFICATION_LABELS[a.classification] || a.classification}</td>
                  <td className="px-4 py-3 text-[#94a3b8]">
                    {a.reputation ? `${a.reputation.fraudScore}${a.reputation.isKnownAbuser ? " · known abuser" : ""}` : "—"}
                  </td>
                  <td className="px-4 py-3 font-mono">{a.riskScore}/100</td>
                  <td className="px-4 py-3">
                    <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full border ${LEVEL_COLORS[a.riskLevel] || ""}`}>{a.riskLevel}</span>
                  </td>
                  <td className={`px-4 py-3 font-bold ${ACTION_COLORS[a.recommendedAction] || ""}`}>{a.recommendedAction}</td>
                  <td className="px-4 py-3 text-[#94a3b8]">{a.surface}</td>
                  <td className="px-4 py-3 text-[#94a3b8] font-mono truncate max-w-[160px]">{a.identityId || "—"}</td>
                  <td className="px-4 py-3 text-[#8a96ab] font-mono">{formatDate(a.createdAt)}</td>
                </tr>
              ))}
              {items.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-6 text-center text-[#8a96ab]">No risk assessments recorded yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
