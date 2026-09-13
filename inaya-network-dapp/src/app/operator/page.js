"use client";

// app/operator/page.js
//
// Node Operator Dashboard SOW — the first self-serve UI node operators
// have ever had (the only prior surfaces, /admin/nodes and the "Node
// Daemon Operators" tab of /admin/dashboard, are passphrase-gated for
// internal ops use). Deliberately a separate page from the main
// wallet-connected dApp (page.js) and from /business: this feature's
// identity is a node operator's wallet signature against a brand-new
// session layer (nodeOperatorAuth.js) -- neither the dApp's own
// WalletContext (scoped to page.js's tree only) nor /business's
// email/session model apply here, so this page builds its own minimal
// connect-and-sign flow using the same `new ethers.BrowserProvider(window
// .ethereum)` pattern already repeated throughout page.js, rather than
// lifting WalletContext into the root layout for one new page.
//
// Node Operator Dashboard Navigation Update SOW (AuroraX feedback) — the
// 7 sections below used to live behind a horizontal top tab bar; they now
// render exactly as before, just selected from OperatorSidebar's left nav
// instead. No section component, route, or API call changed.

import { useState, useEffect, useCallback } from "react";
import { ethers } from "ethers";
import OperatorSidebar from "../../components/operator/OperatorSidebar";
import OperatorOverview from "../../components/operator/OperatorOverview";
import OperatorUptime from "../../components/operator/OperatorUptime";
import OperatorQualification from "../../components/operator/OperatorQualification";
import OperatorRewards from "../../components/operator/OperatorRewards";
import OperatorEvents from "../../components/operator/OperatorEvents";
import OperatorNetwork from "../../components/operator/OperatorNetwork";
import OperatorFleet from "../../components/operator/OperatorFleet";

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

const TAB_TITLES = {
  overview: "Overview",
  uptime: "Uptime & Telemetry",
  qualification: "Qualification",
  rewards: "Tier & Rewards",
  events: "Events",
  network: "Network",
  fleet: "Fleet",
};

function buildLoginMessage(nodeId, timestamp) {
  return ["Inaya Node Action", "action: login", `nodeId: ${nodeId}`, `timestamp: ${timestamp}`].join("\n");
}

export default function OperatorPage() {
  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState(null); // { primary, walletAddress, linkedWallets } once signed in
  const [error, setError] = useState("");
  const [tab, setTab] = useState("overview");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const loadMe = useCallback(async () => {
    try {
      setMe(await api("/api/nodes/operator/me"));
      setError("");
    } catch {
      setMe(null); // not signed in yet -- not an error state, just the logged-out screen
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadMe(); }, [loadMe]);

  async function handleSignIn() {
    setError("");
    if (typeof window === "undefined" || !window.ethereum) {
      setError("No wallet extension found. Install MetaMask (or another injected wallet) to sign in.");
      return;
    }
    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const [address] = await provider.send("eth_requestAccounts", []);
      const signer = await provider.getSigner();
      const timestamp = Date.now();
      const nodeId = address.toLowerCase();
      const message = buildLoginMessage(nodeId, timestamp);
      const signature = await signer.signMessage(message);

      await api("/api/nodes/operator/login", { method: "POST", body: JSON.stringify({ walletAddress: address, message, signature, timestamp }) });
      await loadMe();
    } catch (err) {
      setError(err.message || "Could not sign in with this wallet.");
    }
  }

  async function handleSignOut() {
    try {
      await api("/api/nodes/operator/logout", { method: "POST" });
    } finally {
      setMe(null);
      setTab("overview");
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--inaya-bg)]">
        <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>
      </div>
    );
  }

  if (!me) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--inaya-bg)] px-4">
        <div className="max-w-sm w-full bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-2xl p-8 text-center space-y-4">
          <div className="text-3xl">🛰️</div>
          <h1 className="text-[var(--inaya-text-primary)] text-xl font-bold">Node Operator Dashboard</h1>
          <p className="text-[var(--inaya-text-muted)] text-sm">
            Sign in with the same wallet your node daemon registered with to see its real, measured health, uptime, tier, and rewards.
          </p>
          <button
            onClick={handleSignIn}
            className="w-full py-3 rounded-xl text-sm font-bold uppercase tracking-wide bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black"
          >
            Connect Wallet &amp; Sign In
          </button>
          {error && <p className="text-red-400 text-xs">{error}</p>}
          <p className="text-[var(--inaya-text-muted)] text-[11px]">
            Signing in only proves you own this wallet -- it never moves funds or changes your node's registration.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-[var(--inaya-bg)]">
      <OperatorSidebar
        activeTab={tab}
        onNavigate={(key) => { setTab(key); setMobileNavOpen(false); }}
        walletAddress={me.walletAddress}
        mobileOpen={mobileNavOpen}
        onCloseMobile={() => setMobileNavOpen(false)}
      />

      <div className="flex-1 min-w-0">
        <header className="sticky top-0 z-30 bg-[var(--inaya-bg)]/90 backdrop-blur border-b border-[var(--inaya-border)] px-5 py-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <button onClick={() => setMobileNavOpen(true)} className="md:hidden text-[var(--inaya-text-primary)] p-1" aria-label="Open navigation">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-[18px] h-[18px]">
                <path d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            <div className="min-w-0">
              <h1 className="text-lg font-extrabold text-[var(--inaya-text-primary)] tracking-tight truncate">{TAB_TITLES[tab]}</h1>
              <p className="text-[var(--inaya-text-muted)] text-[12px] font-mono truncate">{me.walletAddress}</p>
            </div>
          </div>
          <button onClick={handleSignOut} className="text-[11px] font-bold uppercase px-3 py-2 rounded-lg bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] text-[var(--inaya-text-primary)] hover:bg-[var(--inaya-overlay-10)] shrink-0">
            Sign out
          </button>
        </header>

        <main className="p-5 md:p-8 max-w-5xl space-y-6">
          {tab === "overview" && <OperatorOverview initialData={me} onRefresh={loadMe} />}
          {tab === "uptime" && <OperatorUptime />}
          {tab === "qualification" && <OperatorQualification />}
          {tab === "rewards" && <OperatorRewards />}
          {tab === "events" && <OperatorEvents />}
          {tab === "network" && <OperatorNetwork />}
          {tab === "fleet" && <OperatorFleet linkedWallets={me.linkedWallets} onLinked={loadMe} />}
        </main>
      </div>
    </div>
  );
}
