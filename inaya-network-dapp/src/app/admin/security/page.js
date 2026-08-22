"use client";

// app/admin/security/page.js
//
// Security Layer admin dashboard — the "monitor" surface for the
// decentralized threat intelligence system (Security Layer SOW). Same
// passphrase-gated session as the Enterprise Dashboard and the Data Room
// admin page (/admin, /admin/dataroom — src/lib/admin-auth.js): POST
// /api/admin/login sets the shared inaya_admin_session cookie, every
// /api/admin/security/* route re-checks it server-side.
//
// Read-only monitoring plus one governance action (status override) —
// deliberately no policy-authoring UI here, that's a separate, smaller
// concern (POST /api/admin/security/policy) not part of "let me see what's
// happening."

import { useState, useEffect, useCallback } from "react";

// Mirrors src/lib/security.js's SECURITY_CATEGORIES / SECURITY_STATUS_LABELS
// exactly (kept as a local constant, not imported — that file pulls in
// server-only deps like mongodb, which can't bundle into a "use client" page).
const CATEGORIES = ["unknown", "phishing", "malware", "scam", "botnet_c2", "spam", "other"];
const STATUS_LABELS = ["Unverified", "Confirmed", "Disputed", "Cleared"];
const STATUS_COLORS = ["text-[#64748b]", "text-[#f87171]", "text-[#fbbf24]", "text-[#94a3b8]"];

function formatPct(bps) {
  return `${((bps || 0) / 100).toFixed(1)}%`;
}

function formatDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

function shortAddr(addr) {
  if (!addr) return "—";
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

export default function SecurityAdminPage() {
  const [passphrase, setPassphrase] = useState("");
  const [authed, setAuthed] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [loading, setLoading] = useState(false);

  const [tab, setTab] = useState("threats"); // threats | nodes
  const [threats, setThreats] = useState([]);
  const [nodes, setNodes] = useState([]);
  const [loadError, setLoadError] = useState("");
  const [overridingId, setOverridingId] = useState(null);

  const loadData = useCallback(async () => {
    setLoadError("");
    try {
      const [threatsRes, nodesRes] = await Promise.all([
        fetch("/api/admin/security/threats"),
        fetch("/api/admin/security/nodes"),
      ]);
      if (!threatsRes.ok || !nodesRes.ok) throw new Error("Session may have expired — please log in again.");
      setThreats((await threatsRes.json()).items);
      setNodes((await nodesRes.json()).items);
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
    } catch {
      setLoginError("Login failed.");
    } finally {
      setLoading(false);
    }
  }

  async function handleOverride(threatId, status) {
    const labels = { 1: "confirm", 2: "dispute", 3: "clear" };
    if (!window.confirm(`Manually ${labels[status]} this threat? This is recorded on-chain as a governance action.`)) return;
    setOverridingId(threatId);
    try {
      const res = await fetch(`/api/admin/security/threats/${threatId}/override`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, confidenceBps: status === 1 ? 9500 : 0 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Override failed.");
      await loadData();
    } catch (err) {
      alert(err.message);
    } finally {
      setOverridingId(null);
    }
  }

  const confirmedCount = threats.filter((t) => t.status === 1).length;
  const unverifiedCount = threats.filter((t) => t.status === 0).length;
  const avgReputation = nodes.length ? Math.round(nodes.reduce((sum, n) => sum + (n.scoreBps || 0), 0) / nodes.length) : null;

  if (!authed) {
    return (
      <div className="min-h-screen bg-[#060913] text-[#e2e8f0] font-sans flex items-center justify-center px-4">
        <form onSubmit={handleLogin} className="bg-[#090d16]/80 border border-white/5 rounded-xl p-8 w-full max-w-sm">
          <h1 className="text-lg font-extrabold text-white mb-1">Security Layer Admin</h1>
          <p className="text-[#94a3b8] text-xs mb-5">Enterprise Dashboard passphrase</p>
          <input
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            className="w-full bg-black/30 border border-white/10 focus:border-[#00f2fe]/40 rounded-lg px-3 py-2.5 text-sm text-white outline-none mb-3"
            placeholder="Passphrase"
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
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-extrabold text-white">Security Layer</h1>
          <button onClick={loadData} className="text-xs px-4 py-2 bg-white/5 border border-white/10 rounded-lg hover:bg-white/10">
            Refresh
          </button>
        </div>

        {loadError && <p className="text-red-400 text-sm mb-4">{loadError}</p>}

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
          <div className="bg-[#0a0f1e] border border-white/10 rounded-xl p-5">
            <div className="text-[#64748b] text-xs mb-1">Confirmed Threats</div>
            <div className="text-2xl font-bold text-[#f87171]">{confirmedCount}</div>
          </div>
          <div className="bg-[#0a0f1e] border border-white/10 rounded-xl p-5">
            <div className="text-[#64748b] text-xs mb-1">Unverified / Collecting</div>
            <div className="text-2xl font-bold">{unverifiedCount}</div>
          </div>
          <div className="bg-[#0a0f1e] border border-white/10 rounded-xl p-5">
            <div className="text-[#64748b] text-xs mb-1">Reporting Nodes</div>
            <div className="text-2xl font-bold">{nodes.length}</div>
          </div>
          <div className="bg-[#0a0f1e] border border-white/10 rounded-xl p-5">
            <div className="text-[#64748b] text-xs mb-1">Avg Node Reputation</div>
            <div className="text-2xl font-bold">{avgReputation != null ? formatPct(avgReputation) : "—"}</div>
          </div>
        </div>

        <div className="flex gap-2 mb-6">
          {[["threats", `Threats (${threats.length})`], ["nodes", `Nodes (${nodes.length})`]].map(([id, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`px-4 py-2 text-xs font-bold rounded-lg transition-all ${tab === id ? "text-white bg-gradient-to-r from-[#00f2fe]/20 to-[#4facfe]/5 border border-[#00f2fe]/40" : "text-[#64748b] border border-white/5 hover:text-slate-300"}`}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === "threats" && (
          <div className="space-y-2">
            {threats.map((t) => (
              <div key={t._id} className="bg-[#090d16]/80 border border-white/5 rounded-xl p-4">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div>
                    <p className="text-white text-sm font-semibold">{t.indicator}</p>
                    <p className="text-[#64748b] text-[11px] font-mono mt-0.5">
                      {CATEGORIES[t.category] || "unknown"} · {(t.contributingNodes || []).length} independent reporter(s)
                    </p>
                  </div>
                  <div className="flex items-center gap-4 text-xs">
                    <div className="text-right">
                      <p className={`font-bold ${STATUS_COLORS[t.status] || ""}`}>{STATUS_LABELS[t.status] || "Unknown"}</p>
                      <p className="text-[#64748b] font-mono text-[10px]">{formatPct(t.confidenceBps)} confidence</p>
                    </div>
                    <div className="flex gap-1">
                      {t.status !== 1 && (
                        <button
                          disabled={overridingId === t._id}
                          onClick={() => handleOverride(t._id, 1)}
                          className="text-[#00f2fe] hover:text-white font-bold text-[10px] px-2 py-1 border border-[#00f2fe]/30 rounded"
                        >
                          Confirm
                        </button>
                      )}
                      {t.status !== 3 && (
                        <button
                          disabled={overridingId === t._id}
                          onClick={() => handleOverride(t._id, 3)}
                          className="text-[#94a3b8] hover:text-white font-bold text-[10px] px-2 py-1 border border-white/10 rounded"
                        >
                          Clear
                        </button>
                      )}
                    </div>
                  </div>
                </div>
                <p className="text-[#64748b] text-[10px] font-mono mt-2">
                  First seen: {formatDate(t.firstSeen)} · Last updated: {formatDate(t.lastUpdated)}
                  {t.onChainTxHash && (
                    <>
                      {" · "}
                      <a
                        href={`https://testnet.bscscan.com/tx/${t.onChainTxHash}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[#00f2fe] hover:underline"
                      >
                        on-chain tx ↗
                      </a>
                    </>
                  )}
                </p>
              </div>
            ))}
            {threats.length === 0 && <p className="text-[#64748b] text-sm">No threats reported yet.</p>}
          </div>
        )}

        {tab === "nodes" && (
          <div className="space-y-2">
            {nodes.map((n) => (
              <div key={n._id} className="bg-[#090d16]/80 border border-white/5 rounded-xl p-4 flex items-center justify-between flex-wrap gap-2">
                <div>
                  <p className="text-white text-sm font-mono font-semibold">{shortAddr(n._id)}</p>
                  <p className="text-[#64748b] text-[11px] font-mono mt-0.5">
                    {n.totalConfirmed || 0} confirmed · {n.totalFalsePositive || 0} false positive
                  </p>
                </div>
                <div className="text-right text-xs">
                  <p className="text-[#00f2fe] font-bold">{formatPct(n.scoreBps)}</p>
                  <p className="text-[#64748b] font-mono text-[10px]">
                    {n.checkpointedAt ? `checkpointed ${formatDate(n.checkpointedAt)}` : "not yet checkpointed on-chain"}
                  </p>
                </div>
              </div>
            ))}
            {nodes.length === 0 && <p className="text-[#64748b] text-sm">No reporting nodes yet.</p>}
          </div>
        )}
      </div>
    </div>
  );
}
