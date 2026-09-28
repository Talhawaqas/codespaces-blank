"use client";

// app/moderator/page.js
//
// Moderator Dashboard — a deliberately LIMITED view (Watcher Pioneer wallets
// + KYC'd individuals only), separate from /admin. Gated by
// MODERATOR_DASHBOARD_PASSPHRASE (see src/lib/moderator-auth.js) — every
// /api/moderator/* route re-checks auth server-side, this page never
// trusts client-side state alone. Same no-websocket, load-on-request
// convention as the admin dashboard.

import { useState } from "react";

function formatDate(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

const STATUS_COLORS = {
  verified: "#2ecc71",
  pending: "#f1c40f",
  rejected: "#e74c3c",
};

export default function ModeratorDashboard() {
  const [passphrase, setPassphrase] = useState("");
  const [authed, setAuthed] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [watchers, setWatchers] = useState(null);
  const [kycIndividuals, setKycIndividuals] = useState(null);
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");

  async function loadDashboardData() {
    setLoading(true);
    setLoadError("");
    try {
      const res = await fetch("/api/moderator/dashboard");
      if (!res.ok) throw new Error("Could not load moderator dashboard — session may have expired.");
      const data = await res.json();
      setWatchers(data.watchers);
      setKycIndividuals(data.kycIndividuals);
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
      const res = await fetch("/api/moderator/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passphrase }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Invalid passphrase.");
      }
      setAuthed(true);
      setPassphrase("");
      await loadDashboardData();
    } catch (err) {
      setLoginError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleLogout() {
    await fetch("/api/moderator/logout", { method: "POST" });
    setAuthed(false);
    setWatchers(null);
    setKycIndividuals(null);
  }

  if (!authed) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#0a0e17", color: "#e5e7eb", fontFamily: "system-ui, sans-serif" }}>
        <form onSubmit={handleLogin} style={{ background: "#111827", padding: 32, borderRadius: 12, width: 340, border: "1px solid #1f2937" }}>
          <h1 style={{ fontSize: 18, marginBottom: 4 }}>Moderator Dashboard</h1>
          <p style={{ fontSize: 12, color: "#9ca3af", marginBottom: 20 }}>Watcher Pioneer Program + KYC'd individuals only.</p>
          <input
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder="Moderator passphrase"
            autoFocus
            style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid #374151", background: "#0a0e17", color: "#e5e7eb", marginBottom: 12, boxSizing: "border-box" }}
          />
          <button type="submit" disabled={loading || !passphrase} style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: "none", background: loading || !passphrase ? "#1f2937" : "#00f2fe", color: loading || !passphrase ? "#6b7280" : "#0a0e17", fontWeight: 700, cursor: loading || !passphrase ? "default" : "pointer" }}>
            {loading ? "Checking…" : "Sign in"}
          </button>
          {loginError ? <p style={{ color: "#f87171", fontSize: 12, marginTop: 10 }}>{loginError}</p> : null}
        </form>
      </div>
    );
  }

  const filteredKyc = (kycIndividuals || []).filter((k) => {
    if (statusFilter !== "all" && k.status !== statusFilter) return false;
    if (search && !k.email.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  return (
    <div style={{ minHeight: "100vh", background: "#0a0e17", color: "#e5e7eb", fontFamily: "system-ui, sans-serif", padding: "32px 24px" }}>
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
          <div>
            <h1 style={{ fontSize: 20, margin: 0 }}>Moderator Dashboard</h1>
            <p style={{ fontSize: 12, color: "#9ca3af", margin: "4px 0 0" }}>Watcher Pioneer Program + KYC'd individuals</p>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={loadDashboardData} disabled={loading} style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #374151", background: "transparent", color: "#e5e7eb", cursor: "pointer" }}>
              {loading ? "Refreshing…" : "Refresh"}
            </button>
            <button onClick={handleLogout} style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #374151", background: "transparent", color: "#9ca3af", cursor: "pointer" }}>
              Sign out
            </button>
          </div>
        </div>

        {loadError ? <p style={{ color: "#f87171", fontSize: 13, marginBottom: 16 }}>{loadError}</p> : null}

        {/* Watcher Pioneer table */}
        <section style={{ marginBottom: 32 }}>
          <h2 style={{ fontSize: 14, textTransform: "uppercase", letterSpacing: 0.5, color: "#9ca3af", marginBottom: 10 }}>
            Watcher Pioneer Program ({watchers?.length ?? 0} wallets)
          </h2>
          <div style={{ overflowX: "auto", border: "1px solid #1f2937", borderRadius: 10 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "#111827", textAlign: "left" }}>
                  <th style={th}>Wallet</th>
                  <th style={th}>Points</th>
                  <th style={th}>INAYA</th>
                  <th style={th}>Active session</th>
                  <th style={th}>Enrolled</th>
                </tr>
              </thead>
              <tbody>
                {(watchers || []).map((w) => (
                  <tr key={w.walletAddress} style={{ borderTop: "1px solid #1f2937" }}>
                    <td style={{ ...td, fontFamily: "monospace" }}>{w.walletAddress}</td>
                    <td style={td}>{w.points.toLocaleString()}</td>
                    <td style={td}>{w.inaya.toLocaleString()}</td>
                    <td style={td}>{w.active ? <span style={{ color: "#2ecc71" }}>● active</span> : <span style={{ color: "#6b7280" }}>—</span>}</td>
                    <td style={td}>{formatDate(w.enrolledAt)}</td>
                  </tr>
                ))}
                {watchers && watchers.length === 0 ? (
                  <tr><td colSpan={5} style={{ ...td, textAlign: "center", color: "#6b7280" }}>No enrolled wallets yet.</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>

        {/* KYC'd individuals table */}
        <section>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 10 }}>
            <h2 style={{ fontSize: 14, textTransform: "uppercase", letterSpacing: 0.5, color: "#9ca3af", margin: 0 }}>
              KYC'd Individuals ({filteredKyc.length}{statusFilter !== "all" || search ? ` of ${kycIndividuals?.length ?? 0}` : ""})
            </h2>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search email…"
                style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #374151", background: "#111827", color: "#e5e7eb", fontSize: 12 }}
              />
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #374151", background: "#111827", color: "#e5e7eb", fontSize: 12 }}>
                <option value="all">All statuses</option>
                <option value="verified">Verified</option>
                <option value="pending">Pending</option>
                <option value="rejected">Rejected</option>
              </select>
            </div>
          </div>
          <div style={{ overflowX: "auto", border: "1px solid #1f2937", borderRadius: 10 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "#111827", textAlign: "left" }}>
                  <th style={th}>Email</th>
                  <th style={th}>Role</th>
                  <th style={th}>Status</th>
                  <th style={th}>Detail</th>
                  <th style={th}>Created</th>
                </tr>
              </thead>
              <tbody>
                {filteredKyc.map((k, i) => (
                  <tr key={`${k.email}-${k.role}-${i}`} style={{ borderTop: "1px solid #1f2937" }}>
                    <td style={td}>{k.email}</td>
                    <td style={td}>{k.role === "referrer" ? "Referrer" : `Referred (by ${k.referredBy})`}</td>
                    <td style={{ ...td, color: STATUS_COLORS[k.status] || "#e5e7eb", fontWeight: 600, textTransform: "capitalize" }}>{k.status}</td>
                    <td style={td}>
                      {k.status === "rejected" && k.rejectionReason ? k.rejectionReason
                        : k.status === "verified" ? `Verified ${formatDate(k.verifiedAt)}`
                        : k.role === "referrer" && k.successfulReferralCount ? `${k.successfulReferralCount} successful referrals`
                        : "—"}
                    </td>
                    <td style={td}>{formatDate(k.createdAt)}</td>
                  </tr>
                ))}
                {kycIndividuals && filteredKyc.length === 0 ? (
                  <tr><td colSpan={5} style={{ ...td, textAlign: "center", color: "#6b7280" }}>No matching records.</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}

const th = { padding: "10px 14px", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: "#9ca3af", fontWeight: 600 };
const td = { padding: "10px 14px", color: "#e5e7eb" };
