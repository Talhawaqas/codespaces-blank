"use client";

// app/admin/dashboard/page.js
//
// Private owner-only dashboard — not linked from anywhere on the public
// site. Visit as /admin/dashboard?key=YOUR_SECRET (the same value as
// ADMIN_DASHBOARD_SECRET, set in Vercel's env vars). Bookmark the full URL
// with the key included; there's no login form, this is a one-person view.

import { useState, useEffect, useCallback } from "react";

const FEEDBACK_STATUSES = ["New", "Reviewing", "Confirmed", "In Progress", "Resolved", "Rejected"];

function Bar({ value, max, color }) {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <div className="w-full h-1.5 bg-white/5 rounded-full overflow-hidden">
      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

function StatTile({ label, value }) {
  return (
    <div className="bg-black/20 border border-white/10 rounded-xl p-3">
      <div className="text-lg font-extrabold text-white">{value}</div>
      <div className="text-[11px] uppercase tracking-wide text-[#8a96ab] mt-0.5">{label}</div>
    </div>
  );
}

function FilterChips({ options, value, onChange }) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={`text-[12px] font-bold uppercase tracking-wide px-3 py-1.5 rounded-full border transition-colors ${
            value === opt.value
              ? "bg-[#00f2fe]/15 text-[#00f2fe] border-[#00f2fe]/40"
              : "bg-white/5 text-[#8a96ab] border-white/10 hover:text-slate-300"
          }`}
        >
          {opt.label}{opt.count != null ? ` (${opt.count})` : ""}
        </button>
      ))}
    </div>
  );
}

function FeedbackRow({ item, adminKey, onChanged }) {
  const [expanded, setExpanded] = useState(false);
  const [notes, setNotes] = useState(item.adminNotes || "");
  const [saving, setSaving] = useState(false);

  async function patch(body) {
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/feedback/${item._id}?key=${encodeURIComponent(adminKey)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      onChanged(json);
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete "${item.title}"? This can't be undone.`)) return;
    try {
      const res = await fetch(`/api/admin/feedback/${item._id}?key=${encodeURIComponent(adminKey)}`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      onChanged(null, item._id);
    } catch (err) {
      alert(err.message);
    }
  }

  const severityColor = { Critical: "#f87171", High: "#f59e0b", Medium: "#00f2fe", Low: "#64748b" }[item.severity] || "#64748b";

  return (
    <div className="border border-white/10 rounded-xl p-4 bg-black/20">
      <div className="flex items-start justify-between gap-3 cursor-pointer" onClick={() => setExpanded((e) => !e)}>
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs">
            <span>{item.type === "bug" ? "🐛" : "💡"}</span>
            <span className="font-bold text-white truncate">{item.title}</span>
            {item.severity && <span className="text-[11px] font-bold uppercase px-1.5 py-0.5 rounded" style={{ color: severityColor, background: `${severityColor}1a` }}>{item.severity}</span>}
          </div>
          <p className="text-[12px] text-[#8a96ab] font-mono mt-1">{item.category} · {new Date(item.createdAt).toLocaleString()}</p>
        </div>
        <span className="text-[11px] font-bold uppercase tracking-wide px-2 py-1 rounded-full border bg-white/5 text-slate-300 border-white/10 shrink-0">{item.status}</span>
      </div>

      {expanded && (
        <div className="mt-4 pt-4 border-t border-white/10 space-y-3 text-xs" onClick={(e) => e.stopPropagation()}>
          <p className="text-slate-300 whitespace-pre-wrap">{item.description}</p>
          {item.reproductionSteps && (
            <div>
              <p className="text-[#8a96ab] font-bold uppercase text-[11px] mb-1">Steps to reproduce</p>
              <p className="text-slate-300 whitespace-pre-wrap font-mono">{item.reproductionSteps}</p>
            </div>
          )}
          {item.attachmentUrl && (
            <a href={item.attachmentUrl} target="_blank" rel="noreferrer" className="text-[#00f2fe] underline break-all">📎 View attachment</a>
          )}
          <div className="grid grid-cols-2 gap-2 font-mono text-[12px] text-[#94a3b8] bg-white/5 rounded-lg p-3">
            <span>Wallet: {item.walletAddress || "—"}</span>
            <span>Route: {item.route || "—"}</span>
            <span>Device: {item.device || "—"}</span>
            <span>Browser: {item.browser || "—"}</span>
            <span>Network: {item.network || "—"}</span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              value={item.status}
              onChange={(e) => patch({ status: e.target.value })}
              disabled={saving}
              className="bg-black/30 border border-white/10 rounded-lg px-2 py-1.5 text-white text-[13px]"
            >
              {FEEDBACK_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <button onClick={handleDelete} className="text-[12px] font-bold uppercase text-red-400 border border-red-400/30 bg-red-400/10 px-2.5 py-1.5 rounded-lg hover:bg-red-400/20">
              Delete
            </button>
          </div>

          <div>
            <p className="text-[#8a96ab] font-bold uppercase text-[11px] mb-1">Admin notes</p>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              onBlur={() => notes !== (item.adminNotes || "") && patch({ adminNotes: notes })}
              rows={2}
              className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-white text-[13px] focus:outline-none focus:border-[#00f2fe]/50"
              placeholder="Internal notes…"
            />
          </div>
        </div>
      )}
    </div>
  );
}

const TABS = [
  { key: "referrals", label: "Referral Dashboard" },
  { key: "watchers", label: "Watcher Node Analytics" },
  { key: "nodeOperators", label: "Node Daemon Operators" },
  { key: "businesses", label: "Business Customers" },
  { key: "feedback", label: "Testnet Feedback" },
];

// Duplicated from src/lib/orgPlans.js — that file imports mongodb.js, which
// can't be pulled into a client component (same reason FEEDBACK_CATEGORIES
// is duplicated in page.js). Keep in sync with PLANS there.
const PLAN_LABELS = {
  starter: "Starter",
  professional: "Professional",
  business: "Business",
  enterprise: "Enterprise",
};
const PLAN_COLORS = {
  starter: "#34d399",
  professional: "#00f2fe",
  business: "#a78bfa",
  enterprise: "#fbbf24",
};
const NO_PLAN_COLOR = "#64748b";

const SUBSCRIPTION_STATUS_COLORS = {
  trialing: "#00f2fe",
  active: "#34d399",
  past_due: "#f59e0b",
  canceled: "#f87171",
};

export default function AdminDashboardPage() {
  const [activeTab, setActiveTab] = useState("referrals");
  const [referralFilter, setReferralFilter] = useState("all"); // all | pending | verified | rejected
  const [watcherFilter, setWatcherFilter] = useState("all"); // all | active | inactive
  const [nodeOperatorFilter, setNodeOperatorFilter] = useState("all"); // all | active | inactive
  const [businessFilter, setBusinessFilter] = useState("all"); // all | starter | professional | business | enterprise | none
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState(null);
  const [feedbackError, setFeedbackError] = useState("");
  const adminKey = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("key") || "" : "";

  const loadFeedback = useCallback(() => {
    fetch(`/api/admin/feedback?key=${encodeURIComponent(adminKey)}`)
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
        setFeedback(json.submissions);
      })
      .catch((err) => setFeedbackError(err.message));
  }, [adminKey]);

  useEffect(() => {
    const key = new URLSearchParams(window.location.search).get("key") || "";
    fetch(`/api/admin/dashboard?key=${encodeURIComponent(key)}`)
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
        setData(json);
      })
      .catch((err) => setError(err.message));
    loadFeedback();
  }, [loadFeedback]);

  function handleFeedbackChanged(updated, deletedId) {
    setFeedback((prev) => {
      if (deletedId) return prev.filter((f) => f._id !== deletedId);
      return prev.map((f) => (f._id === updated._id ? updated : f));
    });
  }

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

  const referralCounts = {
    all: data.referrers.length,
    pending: data.referrers.filter((r) => r.status === "pending").length,
    verified: data.referrers.filter((r) => r.status === "verified").length,
    rejected: data.referrers.filter((r) => r.status === "rejected").length,
  };
  const filteredReferrers = referralFilter === "all" ? data.referrers : data.referrers.filter((r) => r.status === referralFilter);

  const watcherCounts = { all: data.watchers.length, active: activeCount, inactive: data.watchers.length - activeCount };
  const filteredWatchers = watcherFilter === "all" ? data.watchers : data.watchers.filter((w) => (watcherFilter === "active" ? w.active : !w.active));

  const nodeOperatorList = data.nodeOperators?.nodes || [];
  const nodeOperatorCounts = {
    all: nodeOperatorList.length,
    active: nodeOperatorList.filter((n) => n.active).length,
    inactive: nodeOperatorList.filter((n) => !n.active).length,
  };
  const filteredNodeOperators =
    nodeOperatorFilter === "all" ? nodeOperatorList : nodeOperatorList.filter((n) => (nodeOperatorFilter === "active" ? n.active : !n.active));

  const businessCounts = {
    all: data.businesses.length,
    starter: data.businesses.filter((b) => b.plan === "starter").length,
    professional: data.businesses.filter((b) => b.plan === "professional").length,
    business: data.businesses.filter((b) => b.plan === "business").length,
    enterprise: data.businesses.filter((b) => b.plan === "enterprise").length,
    none: data.businesses.filter((b) => !b.plan).length,
  };
  const filteredBusinesses =
    businessFilter === "all"
      ? data.businesses
      : businessFilter === "none"
      ? data.businesses.filter((b) => !b.plan)
      : data.businesses.filter((b) => b.plan === businessFilter);

  return (
    <div className="min-h-screen bg-[#060913] text-[#e2e8f0] font-sans px-4 py-10 md:px-10">
      <div className="max-w-5xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl font-extrabold text-white">Admin Dashboard</h1>
          <p className="text-[#8a96ab] text-xs font-mono mt-1">Private view — not linked publicly.</p>
        </div>

        {data.mobileDownloads && (
          <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-4 flex items-center justify-between flex-wrap gap-3">
            <div>
              <p className="text-[12px] uppercase tracking-wide text-[#8a96ab] font-bold">📱 Mobile App (.apk) Downloads</p>
              <p className="text-xl font-extrabold text-white mt-0.5">{data.mobileDownloads.total.toLocaleString()}</p>
            </div>
            <span className="text-[12px] text-[#8a96ab] font-mono">
              Latest release: {data.mobileDownloads.latestVersion || "—"} · counted by GitHub Releases
            </span>
          </div>
        )}

        {data.nodeOperators && (
          <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-4 flex items-center justify-between flex-wrap gap-3">
            <div>
              <p className="text-[12px] uppercase tracking-wide text-[#8a96ab] font-bold">🖥️ Inaya Node Daemon Operators</p>
              <p className="text-xl font-extrabold text-white mt-0.5">
                {data.nodeOperators.active.toLocaleString()} <span className="text-emerald-400 text-sm font-bold">running now</span>
              </p>
            </div>
            <span className="text-[12px] text-[#8a96ab] font-mono">
              {data.nodeOperators.total.toLocaleString()} registered total · "running now" = heartbeat in the last 10 min
            </span>
          </div>
        )}

        {/* TAB NAV */}
        <div className="flex bg-[#090d16] border border-white/5 rounded-xl p-1 gap-1 flex-wrap">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex-1 min-w-[140px] py-2 px-3 text-xs font-bold uppercase rounded-lg transition-colors ${
                activeTab === tab.key ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[#94a3b8] hover:text-slate-300"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* TAB 1: Referral Dashboard */}
        {activeTab === "referrals" && (
          <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6">
            <div className="flex items-baseline justify-between mb-4 flex-wrap gap-2">
              <h2 className="text-sm font-bold text-white">Referral Dashboard</h2>
              <span className="text-[12px] text-[#8a96ab] font-mono">{filteredReferrers.length} of {data.referrers.length} referrers</span>
            </div>
            <div className="mb-4">
              <FilterChips
                value={referralFilter}
                onChange={setReferralFilter}
                options={[
                  { value: "all", label: "All", count: referralCounts.all },
                  { value: "pending", label: "Pending", count: referralCounts.pending },
                  { value: "verified", label: "Verified", count: referralCounts.verified },
                  { value: "rejected", label: "Rejected", count: referralCounts.rejected },
                ]}
              />
            </div>
            {filteredReferrers.length === 0 ? (
              <p className="text-[#8a96ab] text-xs italic">No referrers match this filter.</p>
            ) : (
              <div className="space-y-3">
                {filteredReferrers.map((r) => (
                  <div key={r.email} className="grid grid-cols-[1fr_auto] gap-3 items-center">
                    <div>
                      <div className="flex items-baseline justify-between text-xs mb-1">
                        <span className="font-mono text-slate-300 truncate">{r.email}</span>
                        <span className="font-mono font-bold text-[#00f2fe] ml-3 shrink-0">{r.referrals}</span>
                      </div>
                      <Bar value={r.referrals} max={maxReferrals} color="#00f2fe" />
                    </div>
                    <span className="text-[11px] font-bold uppercase tracking-wide text-[#8a96ab] w-16 text-right">{r.status}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* TAB 2: Watcher Node Analytics */}
        {activeTab === "watchers" && (
          <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6">
            <div className="flex items-baseline justify-between mb-4 flex-wrap gap-2">
              <h2 className="text-sm font-bold text-white">Watcher Node Analytics</h2>
              <span className="text-[12px] text-[#8a96ab] font-mono">{filteredWatchers.length} of {data.watchers.length} wallets</span>
            </div>
            <div className="mb-4">
              <FilterChips
                value={watcherFilter}
                onChange={setWatcherFilter}
                options={[
                  { value: "all", label: "All", count: watcherCounts.all },
                  { value: "active", label: "Active", count: watcherCounts.active },
                  { value: "inactive", label: "Inactive", count: watcherCounts.inactive },
                ]}
              />
            </div>
            {filteredWatchers.length === 0 ? (
              <p className="text-[#8a96ab] text-xs italic">No wallets match this filter.</p>
            ) : (
              <div className="space-y-3">
                {filteredWatchers.map((w) => (
                  <div key={w.walletAddress} className="grid grid-cols-[1fr_auto_auto] gap-3 items-center">
                    <div>
                      <div className="flex items-baseline justify-between text-xs mb-1">
                        <span className="font-mono text-slate-300 truncate">{w.walletAddress}</span>
                        <span className="font-mono ml-3 shrink-0">
                          <span className="font-bold text-emerald-400">{w.points.toLocaleString()} pts</span>
                          <span className="text-[#8a96ab]"> · {w.inaya.toFixed(2)} INAYA</span>
                        </span>
                      </div>
                      <Bar value={w.points} max={maxPoints} color="#34d399" />
                    </div>
                    <span
                      className={`text-[11px] font-bold uppercase tracking-wide px-2 py-1 rounded-full border text-center ${
                        w.active
                          ? "bg-emerald-400/10 text-emerald-400 border-emerald-400/30"
                          : "bg-white/5 text-[#8a96ab] border-white/10"
                      }`}
                    >
                      {w.active ? "Active" : "Inactive"}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* TAB: Node Daemon Operators */}
        {activeTab === "nodeOperators" && (
          <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6">
            <div className="flex items-baseline justify-between mb-4 flex-wrap gap-2">
              <h2 className="text-sm font-bold text-white">Node Daemon Operators</h2>
              <span className="text-[12px] text-[#8a96ab] font-mono">
                {filteredNodeOperators.length} of {nodeOperatorList.length} nodes
              </span>
            </div>
            <div className="mb-4">
              <FilterChips
                value={nodeOperatorFilter}
                onChange={setNodeOperatorFilter}
                options={[
                  { value: "all", label: "All", count: nodeOperatorCounts.all },
                  { value: "active", label: "Running now", count: nodeOperatorCounts.active },
                  { value: "inactive", label: "Not running", count: nodeOperatorCounts.inactive },
                ]}
              />
            </div>
            {filteredNodeOperators.length === 0 ? (
              <p className="text-[#8a96ab] text-xs italic">No nodes match this filter.</p>
            ) : (
              <div className="space-y-3">
                {filteredNodeOperators.map((n) => (
                  <div key={n.nodeId} className="grid grid-cols-[1fr_auto] gap-3 items-center border border-white/10 rounded-xl p-3 bg-black/20">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 text-xs">
                        <span className="font-mono text-slate-300 truncate">{n.operatorWallet || n.nodeId}</span>
                        <span className="text-[11px] font-bold uppercase px-1.5 py-0.5 rounded shrink-0 bg-[#00f2fe]/10 text-[#00f2fe]">
                          {n.tier}
                        </span>
                      </div>
                      <p className="text-[12px] text-[#8a96ab] font-mono mt-1">
                        {n.totalCapacityGB.toLocaleString()} GB declared · last heartbeat:{" "}
                        {n.lastHeartbeatAt ? new Date(n.lastHeartbeatAt).toLocaleString() : "never"}
                      </p>
                    </div>
                    <span
                      className={`text-[11px] font-bold uppercase tracking-wide px-2 py-1 rounded-full border text-center ${
                        n.active
                          ? "bg-emerald-400/10 text-emerald-400 border-emerald-400/30"
                          : "bg-white/5 text-[#8a96ab] border-white/10"
                      }`}
                    >
                      {n.active ? "Running now" : "Not running"}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* TAB 3: Business Customers */}
        {activeTab === "businesses" && (
          <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6">
            <div className="flex items-baseline justify-between mb-4 flex-wrap gap-2">
              <h2 className="text-sm font-bold text-white">Business Customers</h2>
              <span className="text-[12px] text-[#8a96ab] font-mono">{filteredBusinesses.length} of {data.businesses.length} companies</span>
            </div>
            <div className="mb-4">
              <FilterChips
                value={businessFilter}
                onChange={setBusinessFilter}
                options={[
                  { value: "all", label: "All", count: businessCounts.all },
                  { value: "starter", label: "Starter", count: businessCounts.starter },
                  { value: "professional", label: "Professional", count: businessCounts.professional },
                  { value: "business", label: "Business", count: businessCounts.business },
                  { value: "enterprise", label: "Enterprise", count: businessCounts.enterprise },
                  { value: "none", label: "No Plan", count: businessCounts.none },
                ]}
              />
            </div>
            {filteredBusinesses.length === 0 ? (
              <p className="text-[#8a96ab] text-xs italic">No companies match this filter.</p>
            ) : (
              <div className="space-y-3">
                {filteredBusinesses.map((b) => {
                  const planColor = b.plan ? PLAN_COLORS[b.plan] || NO_PLAN_COLOR : NO_PLAN_COLOR;
                  const statusColor = b.subscriptionStatus ? SUBSCRIPTION_STATUS_COLORS[b.subscriptionStatus] || NO_PLAN_COLOR : null;
                  return (
                    <div key={b.orgId} className="grid grid-cols-[1fr_auto] gap-3 items-center border border-white/10 rounded-xl p-3 bg-black/20">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-xs">
                          <span className="font-bold text-white truncate">{b.name}</span>
                          <span
                            className="text-[11px] font-bold uppercase px-1.5 py-0.5 rounded shrink-0"
                            style={{ color: planColor, background: `${planColor}1a` }}
                          >
                            {b.planName}
                          </span>
                          {b.subscriptionStatus && (
                            <span
                              className="text-[11px] font-bold uppercase px-1.5 py-0.5 rounded shrink-0"
                              style={{ color: statusColor, background: `${statusColor}1a` }}
                            >
                              {b.subscriptionStatus.replace("_", " ")}
                            </span>
                          )}
                        </div>
                        <p className="text-[12px] text-[#8a96ab] font-mono mt-1 truncate">
                          {b.ownerEmail} · {b.memberCount} {b.memberCount === 1 ? "user" : "users"}
                          {b.billingInterval ? ` · ${b.billingInterval}ly` : ""}
                        </p>
                      </div>
                      <span className="text-[11px] font-mono text-[#8a96ab] shrink-0">
                        {b.createdAt ? new Date(b.createdAt).toLocaleDateString() : "—"}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* TAB 4: Testnet Feedback */}
        {activeTab === "feedback" && (
          <div className="bg-[#090d16]/80 border border-white/5 rounded-2xl p-6">
            <h2 className="text-sm font-bold text-white mb-4">Testnet Feedback</h2>

            {feedbackError ? (
              <p className="text-red-400 text-xs">⚠ {feedbackError}</p>
            ) : !feedback ? (
              <p className="text-[#8a96ab] text-xs">Loading…</p>
            ) : (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-5">
                  <StatTile label="Total" value={feedback.length} />
                  <StatTile label="Bugs" value={feedback.filter((f) => f.type === "bug").length} />
                  <StatTile label="Ideas" value={feedback.filter((f) => f.type === "idea").length} />
                  <StatTile label="Open / New" value={feedback.filter((f) => f.status === "New").length} />
                  <StatTile label="Resolved" value={feedback.filter((f) => f.status === "Resolved").length} />
                </div>

                {feedback.length === 0 ? (
                  <p className="text-[#8a96ab] text-xs italic">No feedback submitted yet.</p>
                ) : (
                  <div className="space-y-3">
                    {feedback.map((item) => (
                      <FeedbackRow key={item._id} item={item} adminKey={adminKey} onChanged={handleFeedbackChanged} />
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
