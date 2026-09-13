"use client";

// src/components/operator/OperatorFleet.js
//
// SOW §15-16: fleet view for a professional operator running more than
// one node. Since the backend's identity model is strictly one wallet =
// one node (no existing "operator owns many nodes" concept), this session
// can LINK additional node wallets -- each independently signature-
// verified -- rather than inventing a new operator-account concept. The
// table below is a thin aggregation over the exact same per-node summary
// GET /me already uses (see nodeOperatorSummary.js), so it can never drift
// from what the single-node view shows for the same wallet.

import { useState, useEffect, useCallback } from "react";
import { ethers } from "ethers";

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

const STATUS_DOT = { healthy: "bg-emerald-400", degraded: "bg-amber-400", offline: "bg-red-400", unknown: "bg-white/30" };

function buildLoginMessage(nodeId, timestamp) {
  return ["Inaya Node Action", "action: login", `nodeId: ${nodeId}`, `timestamp: ${timestamp}`].join("\n");
}

export default function OperatorFleet({ linkedWallets, onLinked }) {
  const [fleet, setFleet] = useState(null);
  const [error, setError] = useState("");
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState("");

  const load = useCallback(async () => {
    try {
      setFleet(await api("/api/nodes/operator/fleet"));
      setError("");
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleLinkWallet() {
    setLinkError("");
    if (typeof window === "undefined" || !window.ethereum) {
      setLinkError("No wallet extension found.");
      return;
    }
    setLinking(true);
    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      // Force the wallet extension to let the operator pick a DIFFERENT
      // account than the one already signed in, rather than silently
      // re-using whichever account is currently active.
      await provider.send("wallet_requestPermissions", [{ eth_accounts: {} }]).catch(() => {});
      const [address] = await provider.send("eth_requestAccounts", []);
      const signer = await provider.getSigner();
      const timestamp = Date.now();
      const nodeId = address.toLowerCase();
      const message = buildLoginMessage(nodeId, timestamp);
      const signature = await signer.signMessage(message);

      await api("/api/nodes/operator/link", { method: "POST", body: JSON.stringify({ walletAddress: address, message, signature, timestamp }) });
      await onLinked();
      await load();
    } catch (err) {
      setLinkError(err.message || "Could not link this wallet.");
    } finally {
      setLinking(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-[var(--inaya-text-muted)] text-xs max-w-md">
          Run more than one node? Link its wallet here (each requires that wallet's own signature) to see them together.
        </p>
        <button onClick={handleLinkWallet} disabled={linking} className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg disabled:opacity-40 shrink-0">
          {linking ? "Linking…" : "+ Link another node wallet"}
        </button>
      </div>
      {linkError && <p className="text-red-400 text-xs">{linkError}</p>}
      {error && <p className="text-red-400 text-xs">{error}</p>}

      {!fleet ? (
        <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <div className="bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-2xl p-4">
              <p className="text-[var(--inaya-text-muted)] text-[11px] font-mono mb-1">Total Nodes</p>
              <p className="text-[var(--inaya-text-primary)] text-xl font-bold tabular-nums">{fleet.totalNodes}</p>
            </div>
            <div className="bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-2xl p-4">
              <p className="text-[var(--inaya-text-muted)] text-[11px] font-mono mb-1">Online</p>
              <p className="text-emerald-400 text-xl font-bold tabular-nums">{fleet.onlineNodes}</p>
            </div>
            <div className="bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-2xl p-4">
              <p className="text-[var(--inaya-text-muted)] text-[11px] font-mono mb-1">Offline</p>
              <p className="text-red-400 text-xl font-bold tabular-nums">{fleet.offlineNodes}</p>
            </div>
            <div className="bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-2xl p-4">
              <p className="text-[var(--inaya-text-muted)] text-[11px] font-mono mb-1">Avg Uptime</p>
              <p className="text-[var(--inaya-text-primary)] text-xl font-bold tabular-nums">{fleet.averageUptimeBps != null ? `${(fleet.averageUptimeBps / 100).toFixed(1)}%` : "—"}</p>
            </div>
            <div className="bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-2xl p-4">
              <p className="text-[var(--inaya-text-muted)] text-[11px] font-mono mb-1">Lowest Uptime</p>
              <p className="text-[var(--inaya-text-primary)] text-xl font-bold tabular-nums">{fleet.lowestUptimeBps != null ? `${(fleet.lowestUptimeBps / 100).toFixed(1)}%` : "—"}</p>
            </div>
          </div>

          <div className="bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-2xl p-5 overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[var(--inaya-text-muted)] uppercase text-[10px]">
                  <th className="text-left py-1.5 pr-4 font-bold">Node</th>
                  <th className="text-left py-1.5 pr-4 font-bold">Status</th>
                  <th className="text-left py-1.5 pr-4 font-bold">Uptime</th>
                  <th className="text-left py-1.5 pr-4 font-bold">Last Seen</th>
                  <th className="text-left py-1.5 pr-4 font-bold">Version</th>
                  <th className="text-left py-1.5 pr-4 font-bold">Tier</th>
                </tr>
              </thead>
              <tbody>
                {fleet.nodes.map((n) => (
                  <tr key={n.wallet} className="border-t border-[var(--inaya-border)]">
                    <td className="py-1.5 pr-4 text-[var(--inaya-text-primary)] font-mono">{n.wallet.slice(0, 6)}…{n.wallet.slice(-4)}</td>
                    <td className="py-1.5 pr-4">
                      <span className="inline-flex items-center gap-1.5">
                        <span className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[n.status] || STATUS_DOT.unknown}`} />
                        <span className="text-[var(--inaya-text-primary)] capitalize">{n.status}</span>
                      </span>
                    </td>
                    <td className="py-1.5 pr-4 text-[var(--inaya-text-primary)] font-mono">{n.telemetry?.uptimeScoreBps != null ? `${(n.telemetry.uptimeScoreBps / 100).toFixed(1)}%` : "—"}</td>
                    <td className="py-1.5 pr-4 text-[var(--inaya-text-muted)] font-mono">{n.telemetry?.lastHeartbeatAt ? new Date(n.telemetry.lastHeartbeatAt).toLocaleString() : "Never"}</td>
                    <td className="py-1.5 pr-4 text-[var(--inaya-text-muted)] font-mono">{n.version?.daemonVersion || "—"}</td>
                    <td className="py-1.5 pr-4 text-[var(--inaya-text-primary)]">{n.tier?.source === "on_chain" ? n.tier.name : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {linkedWallets?.length === 0 && (
        <p className="text-[var(--inaya-text-muted)] text-[11px]">Only your primary node is shown until you link another wallet above.</p>
      )}
    </div>
  );
}
