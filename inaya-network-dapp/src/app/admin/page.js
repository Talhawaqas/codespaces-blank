"use client";

// app/admin/page.js
//
// Phase 3 Tier 2 — internal Enterprise Dashboard. Read-only reporting
// across ALL customers, for the Inaya team's own visibility — NOT the
// customer-facing "My Dashboard" tab in the main page.js, which is left
// completely untouched. Gated by ADMIN_DASHBOARD_PASSPHRASE (see
// src/lib/admin-auth.js) — every /api/admin/* route re-checks auth
// server-side on every request, this page never trusts client-side
// state alone.
//
// No websockets/polling — loads current data on request, per the SOW's
// explicit "don't add real-time infrastructure that wasn't asked for."

import { useState } from "react";

function formatUsd(value) {
  if (value === null || value === undefined) return "Unavailable";
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
}

function formatBytes(value) {
  if (value === null || value === undefined) return "Unavailable";
  if (value === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(value) / Math.log(1024));
  return `${(value / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

function formatDate(ms) {
  if (!ms) return "—";
  return new Date(ms).toLocaleString();
}

export default function AdminDashboard() {
  const [passphrase, setPassphrase] = useState("");
  const [authed, setAuthed] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [loading, setLoading] = useState(false);
  const [revenue, setRevenue] = useState(null);
  const [customers, setCustomers] = useState(null);
  const [usage, setUsage] = useState(null);
  const [activity, setActivity] = useState(null);
  const [loadError, setLoadError] = useState("");

  async function loadDashboardData() {
    setLoading(true);
    setLoadError("");
    try {
      const [revenueRes, customersRes, usageRes, activityRes] = await Promise.all([
        fetch("/api/admin/revenue-overview"),
        fetch("/api/admin/customers"),
        fetch("/api/admin/usage-overview"),
        fetch("/api/admin/activity"),
      ]);
      if (!revenueRes.ok || !customersRes.ok || !usageRes.ok || !activityRes.ok) {
        throw new Error("One or more dashboard endpoints rejected the request — session may have expired.");
      }
      setRevenue(await revenueRes.json());
      setCustomers(await customersRes.json());
      setUsage(await usageRes.json());
      setActivity(await activityRes.json());
    } catch (err) {
      setLoadError(err.message);
    } finally {
      setLoading(false);
    }
  }

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
        setLoading(false);
        return;
      }
      setAuthed(true);
      setPassphrase("");
      await loadDashboardData();
    } catch (err) {
      setLoginError(err.message);
      setLoading(false);
    }
  }

  async function handleLogout() {
    await fetch("/api/admin/logout", { method: "POST" });
    setAuthed(false);
    setRevenue(null);
    setCustomers(null);
    setUsage(null);
    setActivity(null);
  }

  if (!authed) {
    return (
      <div className="min-h-screen bg-[#060913] flex items-center justify-center p-6">
        <form onSubmit={handleLogin} className="w-full max-w-sm bg-[#0a0f1e] border border-[#00f2fe]/15 rounded-2xl p-8 space-y-4">
          <h1 className="text-white font-bold text-lg">Inaya Network — Internal Dashboard</h1>
          <p className="text-[#8a96ab] text-xs">Operator access only. Not the customer-facing dashboard.</p>
          <input
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder="Admin passphrase"
            className="w-full px-4 py-2.5 bg-black/30 border border-white/10 rounded-lg text-white text-sm focus:outline-none focus:border-[#00f2fe]/40"
            autoFocus
          />
          {loginError && <p className="text-red-400 text-xs">{loginError}</p>}
          <button
            type="submit"
            disabled={loading || !passphrase}
            className="w-full py-2.5 bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-[#060913] font-bold text-sm rounded-lg disabled:opacity-40"
          >
            {loading ? "Checking..." : "Enter"}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#060913] p-6 md:p-10 text-white">
      <div className="flex items-center justify-between mb-8">
        <h1 className="font-bold text-xl">Enterprise Dashboard</h1>
        <div className="flex items-center gap-3">
          <a href="/admin/dataroom" className="text-xs px-4 py-2 bg-white/5 border border-white/10 rounded-lg hover:bg-white/10">
            Data Room
          </a>
          <a href="/admin/security" className="text-xs px-4 py-2 bg-white/5 border border-white/10 rounded-lg hover:bg-white/10">
            Security Layer
          </a>
          <a href="/admin/hackathon" className="text-xs px-4 py-2 bg-white/5 border border-white/10 rounded-lg hover:bg-white/10">
            Hackathon
          </a>
          <a href="/admin/fraud" className="text-xs px-4 py-2 bg-white/5 border border-white/10 rounded-lg hover:bg-white/10">
            Fraud &amp; Abuse
          </a>
          <a href="/admin/audit" className="text-xs px-4 py-2 bg-white/5 border border-white/10 rounded-lg hover:bg-white/10">
            Audit Trail
          </a>
          <a href="/admin/faucet" className="text-xs px-4 py-2 bg-white/5 border border-white/10 rounded-lg hover:bg-white/10">
            Faucet
          </a>
          <a href="/admin/rag" className="text-xs px-4 py-2 bg-white/5 border border-white/10 rounded-lg hover:bg-white/10">
            RAG
          </a>
          <button onClick={loadDashboardData} disabled={loading} className="text-xs px-4 py-2 bg-white/5 border border-white/10 rounded-lg hover:bg-white/10">
            {loading ? "Refreshing..." : "Refresh"}
          </button>
          <button onClick={handleLogout} className="text-xs px-4 py-2 bg-white/5 border border-white/10 rounded-lg hover:bg-white/10">
            Log out
          </button>
        </div>
      </div>

      {loadError && <p className="text-red-400 text-sm mb-6">{loadError}</p>}

      {/* Revenue overview */}
      <section className="mb-10">
        <h2 className="text-[#00f2fe] font-mono text-xs font-bold tracking-widest uppercase mb-3">Revenue Overview</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-[#0a0f1e] border border-white/10 rounded-xl p-5">
            <div className="text-[#8a96ab] text-xs mb-1">Corporate Reserve</div>
            <div className="text-2xl font-bold">{revenue ? formatUsd(revenue.corporateReserve.totalUsd) : "—"}</div>
            {revenue && (
              <div className="mt-3 space-y-1 text-xs text-[#94a3b8]">
                {Object.entries(revenue.corporateReserve.byTier).map(([tier, amt]) => (
                  <div key={tier} className="flex justify-between">
                    <span>{tier}</span>
                    <span>{formatUsd(amt)}</span>
                  </div>
                ))}
                <div className="pt-1 text-[#8a96ab]">{revenue.corporateReserve.planCount} plan(s) total</div>
              </div>
            )}
          </div>
          <div className="bg-[#0a0f1e] border border-white/10 rounded-xl p-5">
            <div className="text-[#8a96ab] text-xs mb-1">Pay-As-You-Go</div>
            <div className="text-2xl font-bold">{revenue ? formatUsd(revenue.payg.totalUsd) : "—"}</div>
            {revenue && (
              <div className="mt-3 text-xs text-[#94a3b8]">
                <div>{revenue.payg.assetCount} upload(s), real Stripe amounts</div>
                {revenue.payg.unavailableCount > 0 && <div className="text-amber-400 mt-1">{revenue.payg.unavailableCount} unverifiable — total shown as unavailable</div>}
              </div>
            )}
          </div>
          <div className="bg-[#0a0f1e] border border-white/10 rounded-xl p-5">
            <div className="text-[#8a96ab] text-xs mb-1">Egress</div>
            <div className="text-2xl font-bold">{revenue ? formatUsd(revenue.egress.totalUsd) : "—"}</div>
            {revenue && (
              <div className="mt-3 text-xs text-[#94a3b8]">
                <div>{revenue.egress.unlockCount} unlock(s)</div>
                {revenue.egress.unavailableCount > 0 && <div className="text-amber-400 mt-1">{revenue.egress.unavailableCount} unverifiable — total shown as unavailable</div>}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Active users (DAU/WAU) */}
      <section className="mb-10">
        <h2 className="text-[#00f2fe] font-mono text-xs font-bold tracking-widest uppercase mb-3">Active Users</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[["dapp", "dApp"], ["business", "Business Workspace"], ["mobile", "Mobile App"]].map(([key, label]) => (
            <div key={key} className="bg-[#0a0f1e] border border-white/10 rounded-xl p-5">
              <div className="text-[#8a96ab] text-xs mb-1">{label}</div>
              <div className="flex items-end gap-4 mt-2">
                <div>
                  <div className="text-2xl font-bold">{activity ? activity[key].dau : "—"}</div>
                  <div className="text-[12px] text-[#8a96ab] uppercase tracking-wide mt-0.5">DAU today</div>
                </div>
                <div>
                  <div className="text-lg font-bold text-[#94a3b8]">{activity ? activity[key].wau : "—"}</div>
                  <div className="text-[12px] text-[#8a96ab] uppercase tracking-wide mt-0.5">WAU (7d)</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Usage overview */}
      <section className="mb-10">
        <h2 className="text-[#00f2fe] font-mono text-xs font-bold tracking-widest uppercase mb-3">Usage Overview</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-[#0a0f1e] border border-white/10 rounded-xl p-5">
            <div className="text-[#8a96ab] text-xs mb-1">Total Files Stored</div>
            <div className="text-2xl font-bold">{usage ? usage.totalFilesStored.toLocaleString() : "—"}</div>
          </div>
          <div className="bg-[#0a0f1e] border border-white/10 rounded-xl p-5">
            <div className="text-[#8a96ab] text-xs mb-1">Total Storage Used</div>
            <div className="text-2xl font-bold">{usage ? formatBytes(usage.totalBytesStored) : "—"}</div>
          </div>
          <div className="bg-[#0a0f1e] border border-white/10 rounded-xl p-5">
            <div className="text-[#8a96ab] text-xs mb-1">Wallets With Files</div>
            <div className="text-2xl font-bold">{usage ? usage.totalWallets.toLocaleString() : "—"}</div>
            {usage && usage.totalUnreconciledAcrossAllWallets > 0 && (
              <div className="text-amber-400 text-xs mt-2">{usage.totalUnreconciledAcrossAllWallets} unreconciled record(s) excluded</div>
            )}
          </div>
        </div>
      </section>

      {/* Customer list */}
      <section>
        <h2 className="text-[#00f2fe] font-mono text-xs font-bold tracking-widest uppercase mb-3">
          Corporate Reserve Customers {customers && `(${customers.activeCount} active, ${customers.expiredCount} expired)`}
        </h2>
        <div className="bg-[#0a0f1e] border border-white/10 rounded-xl overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[#8a96ab] text-xs uppercase border-b border-white/10">
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3">Tier</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Activated</th>
                <th className="px-4 py-3">Expires</th>
                <th className="px-4 py-3">Amount</th>
              </tr>
            </thead>
            <tbody>
              {customers?.customers.map((c) => (
                <tr key={c.email} className="border-b border-white/5 last:border-0">
                  <td className="px-4 py-3">{c.email}</td>
                  <td className="px-4 py-3">{c.tier}</td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full border ${c.status === "active" ? "text-emerald-400 border-emerald-400/30 bg-emerald-400/10" : "text-[#8a96ab] border-white/10 bg-white/5"}`}>
                      {c.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-[#94a3b8]">{formatDate(c.activatedAt)}</td>
                  <td className="px-4 py-3 text-[#94a3b8]">{formatDate(c.expiresAt)}</td>
                  <td className="px-4 py-3">{formatUsd(c.amountUsd)}</td>
                </tr>
              ))}
              {customers && customers.customers.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-[#8a96ab]">No Corporate Reserve customers yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
