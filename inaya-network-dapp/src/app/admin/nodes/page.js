"use client";

// app/admin/nodes/page.js
//
// Storage Node Telemetry admin dashboard (Phase 5) — same passphrase-
// gated session as every other /admin/* page. Distinct from
// /admin/security's "Nodes" tab (threat-reporting reputation only): this
// page is the storage-side telemetry — capacity, uptimeScoreBps (now
// actually computed, see nodeReputation.js), and daemon health (version,
// restarts, last error) — that no admin page surfaced before Phase 5.

import { useState, useEffect, useCallback } from "react";

function formatDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

function pctFromBps(bps) {
  return bps === null || bps === undefined ? "—" : `${(bps / 100).toFixed(1)}%`;
}

function isStale(lastHeartbeatAt) {
  if (!lastHeartbeatAt) return true;
  return Date.now() - new Date(lastHeartbeatAt).getTime() > 15 * 60 * 1000; // 3x the 5min interval
}

export default function NodesAdminPage() {
  const [passphrase, setPassphrase] = useState("");
  const [authed, setAuthed] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [loading, setLoading] = useState(false);

  const [nodes, setNodes] = useState(null);
  const [loadError, setLoadError] = useState("");

  const loadData = useCallback(async () => {
    setLoadError("");
    try {
      const res = await fetch("/api/admin/nodes");
      if (!res.ok) throw new Error("Session may have expired — please log in again.");
      setNodes((await res.json()).nodes);
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
          <h1 className="text-lg font-extrabold text-white mb-1">Storage Node Telemetry</h1>
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
            <h1 className="text-2xl font-extrabold text-white">Storage Node Telemetry</h1>
            <p className="text-[#8a96ab] text-xs mt-0.5">
              Capacity, heartbeat regularity (uptimeScoreBps), and daemon health per registered node. Capacity/shard fields stay honestly 0 for every node today — the daemon doesn't store shards yet.
            </p>
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

        <div className="bg-[#0a0f1e] border border-white/10 rounded-xl overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[#8a96ab] uppercase border-b border-white/10">
                <th className="px-4 py-3">Node</th>
                <th className="px-4 py-3">Capacity</th>
                <th className="px-4 py-3">Uptime Score</th>
                <th className="px-4 py-3">Daemon</th>
                <th className="px-4 py-3">Last Error</th>
                <th className="px-4 py-3">Last Heartbeat</th>
              </tr>
            </thead>
            <tbody>
              {(nodes || []).map((n) => (
                <tr key={n.nodeId} className="border-b border-white/5 last:border-0">
                  <td className="px-4 py-3 font-mono truncate max-w-[160px]">{n.nodeId}</td>
                  <td className="px-4 py-3 font-mono">{n.usedCapacityGB}/{n.totalCapacityGB} GB</td>
                  <td className="px-4 py-3 font-mono">{pctFromBps(n.uptimeScoreBps)}</td>
                  <td className="px-4 py-3 text-[#94a3b8]">{n.daemonVersion ? `v${n.daemonVersion}` : "—"}{n.restartCount !== null ? ` · ${n.restartCount} restart(s)` : ""}</td>
                  <td className="px-4 py-3 text-[#94a3b8] truncate max-w-[220px]">{n.lastErrorMessage || "—"}</td>
                  <td className={`px-4 py-3 font-mono ${isStale(n.lastHeartbeatAt) ? "text-red-400" : "text-emerald-400"}`}>{formatDate(n.lastHeartbeatAt)}</td>
                </tr>
              ))}
              {nodes && nodes.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-[#8a96ab]">No nodes have sent a heartbeat yet.</td>
                </tr>
              )}
              {!nodes && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-[#8a96ab]">Loading…</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
