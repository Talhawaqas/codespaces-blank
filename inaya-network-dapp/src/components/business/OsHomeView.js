"use client";

// src/components/business/OsHomeView.js
//
// Enterprise OS SOW, Phase 7 — the "connects everything" screen: pure
// composition of Phases 2-6's already-built pieces, reading identity via
// useOrg() (Phase 1) instead of props, plus a Phase 8 "surfaced, not
// rebuilt" section of plain links into already-complete features. No new
// backend aggregate route — parallel fetches against the APIs already
// shipped, same pattern Workspace's own DashboardView already uses for
// /api/orgs/dashboard.

import { useState, useEffect, useCallback } from "react";
import { useOrg } from "../../contexts/OrgContext";
import TrustHealthCard from "../TrustHealthCard";
import EmptyState from "../EmptyState";
import AccentGraphic from "../AccentGraphic";
import { TileIcon } from "./tileIcons";
import { useCountUp } from "../../hooks/useCountUp";
import { Icon, ICONS } from "./ui/icons";
import { formatCurrency } from "../../lib/format";

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

/** A tiny, real-data-only sparkline. `points` is either null (no history
 *  yet, or this metric has none to show -- see dashboard-trends.js's own
 *  header comment for why only Pending Approvals ever gets one) or an
 *  array of real {day, count} rows; never fabricated. */
function Sparkline({ points }) {
  if (!points || points.length < 2) return null;
  const max = Math.max(1, ...points.map((p) => p.count));
  const w = 100, h = 28;
  const step = w / (points.length - 1);
  const coords = points.map((p, i) => `${(i * step).toFixed(1)},${(h - (p.count / max) * h).toFixed(1)}`);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="absolute bottom-0 left-0 w-full h-7 opacity-40" aria-hidden="true">
      <polyline points={coords.join(" ")} fill="none" stroke="#00f2fe" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Tile({ label, value, onClick, trend }) {
  const displayValue = useCountUp(typeof value === "number" ? value : null);

  return (
    <button
      onClick={onClick}
      className="inaya-card-glow relative overflow-hidden bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-4 text-left"
    >
      <span className="pointer-events-none absolute -right-2 -top-2 text-[#00f2fe] opacity-[0.07]">
        <TileIcon name={label} />
      </span>
      <p className="relative text-4xl font-black text-[var(--inaya-text-primary)] font-mono tabular-nums">
        {value === null || value === undefined ? "—" : displayValue}
      </p>
      <p className="relative text-[11px] uppercase font-bold text-[var(--inaya-text-muted)] mt-1">{label}</p>
      <Sparkline points={trend} />
    </button>
  );
}

// Enterprise OS SOW, Phase 9 — "pop out" a module into its own native
// desktop window via the open_module_window Tauri command (inaya-desktop/
// src-tauri/src/lib.rs). window.__TAURI__ only exists inside the actual
// desktop app, never in a regular browser tab, same detection convention
// SECURITY_FEED_POLL_SCRIPT already uses in lib.rs — the button is simply
// absent everywhere else, not a broken no-op.
function popOutModuleWindow(label, path) {
  if (typeof window === "undefined" || !window.__TAURI__) return;
  window.__TAURI__.core.invoke("open_module_window", { label, path }).catch((err) => console.error("open_module_window failed:", err));
}

function LinkTile({ label, description, onClick, popOutPath }) {
  const isDesktopApp = typeof window !== "undefined" && !!window.__TAURI__;
  return (
    <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-xl p-3.5 hover:bg-white/5 transition-colors flex items-start justify-between gap-2">
      <button onClick={onClick} className="text-left flex-1 min-w-0">
        <p className="text-[13px] font-bold text-[var(--inaya-text-primary)]">{label}</p>
        <p className="text-[11px] text-[var(--inaya-text-muted)] mt-0.5">{description}</p>
      </button>
      {isDesktopApp && popOutPath && (
        <button
          onClick={() => popOutModuleWindow(label.replace(/[^a-zA-Z0-9]/g, ""), popOutPath)}
          title="Open in its own window"
          className="shrink-0 text-[var(--inaya-text-muted)] hover:text-[#00f2fe] p-1"
        >
          ⧉
        </button>
      )}
    </div>
  );
}

/** Phase 8 — "Unified Permissions" needs no resolver work, since
 *  getAccessibleScope() is already the one unified permission resolver;
 *  this is purely a plain-language surfacing of what useOrg() already
 *  knows about the caller's own membership. */
function PermissionsSummary() {
  const { membership, role, can } = useOrg();
  const grants = [
    can.manageOrg() ? "Full organization management (owner/admin)" : null,
    membership?.financeRole ? `Finance: ${membership.financeRole}` : null,
    membership?.hrRole ? `HR: ${membership.hrRole}` : null,
    membership?.managedDepartmentIds?.length ? `Department Manager for ${membership.managedDepartmentIds.length} department(s)` : null,
  ].filter(Boolean);

  return (
    <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-4">
      <p className="text-xs font-bold uppercase tracking-wide text-[var(--inaya-text-muted)] mb-2">Your Permissions</p>
      <p className="text-[13px] text-[var(--inaya-text-primary)] mb-1.5">Role: <span className="font-mono">{role}</span></p>
      {grants.length > 0 ? (
        <ul className="space-y-1">
          {grants.map((g) => (
            <li key={g} className="text-[12px] text-[var(--inaya-text-muted)]">• {g}</li>
          ))}
        </ul>
      ) : (
        <p className="text-[12px] text-[var(--inaya-text-muted)]">Department-scoped member access.</p>
      )}
    </div>
  );
}

function OsAssistantWidget({ orgId }) {
  const [question, setQuestion] = useState("");
  const [reply, setReply] = useState("");
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState("");

  async function ask() {
    if (!question.trim() || asking) return;
    setAsking(true);
    setError("");
    setReply("");
    try {
      const data = await api("/api/ai/os-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId, messages: [{ role: "user", content: question }] }),
      });
      setReply(data.reply);
    } catch (err) {
      setError(err.message);
    } finally {
      setAsking(false);
    }
  }

  return (
    <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-4">
      <p className="text-xs font-bold uppercase tracking-wide text-[var(--inaya-text-muted)] mb-2">Ask the OS Assistant</p>
      <div className="flex gap-2">
        <div className="inaya-input-glow flex-1">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && ask()}
            placeholder="Business or security questions, in one place..."
            className="w-full bg-[#0b1120] rounded-[7px] px-3 py-2 text-[13px] text-[var(--inaya-text-primary)] outline-none"
          />
        </div>
        <button
          onClick={ask}
          disabled={asking || !question.trim()}
          className="px-4 py-2 rounded-lg bg-[#00f2fe]/15 text-[#00f2fe] text-[12px] font-bold disabled:opacity-40"
        >
          {asking ? "…" : "Ask"}
        </button>
      </div>
      {error && <p className="text-[12px] text-red-400 mt-2">{error}</p>}
      {reply && <p className="text-[13px] text-[var(--inaya-text-primary)] mt-3 leading-relaxed whitespace-pre-wrap">{reply}</p>}
    </div>
  );
}

export default function OsHomeView({ onNavigate }) {
  const { orgId, can } = useOrg();
  const [dashboard, setDashboard] = useState(null);
  const [trust, setTrust] = useState(null);
  const [trustError, setTrustError] = useState("");
  const [whatChanged, setWhatChanged] = useState(null);
  const [trends, setTrends] = useState(null);
  const [error, setError] = useState("");
  // Business Workspace UX/UI Makeover SOW -- "Attention Required" (SOW §8).
  // Each of these can legitimately fail for a member without finance/
  // inventory/task access to this scope -- silent-absent on failure,
  // exactly like the trends fetch above, never a page-level error.
  const [overdueTasks, setOverdueTasks] = useState(null);
  const [overdueInvoices, setOverdueInvoices] = useState(null);
  const [lowStockProducts, setLowStockProducts] = useState(null);

  const load = useCallback(async () => {
    setError("");
    const [dashRes, trustRes, changedRes, trendsRes, tasksRes, invoicesRes, stockRes] = await Promise.allSettled([
      api(`/api/orgs/dashboard?orgId=${orgId}`),
      api(`/api/orgs/trust-health?orgId=${orgId}`),
      api(`/api/orgs/activity-center?orgId=${orgId}&period=weekly`),
      api(`/api/orgs/dashboard-trends?orgId=${orgId}`),
      api(`/api/orgs/tasks?orgId=${orgId}&overdue=true`),
      api(`/api/orgs/finance/invoices?orgId=${orgId}`),
      api(`/api/orgs/inventory/products?orgId=${orgId}&lowStockOnly=true`),
    ]);
    if (dashRes.status === "fulfilled") setDashboard(dashRes.value);
    else setError(dashRes.reason.message);
    if (trustRes.status === "fulfilled") setTrust(trustRes.value);
    else setTrustError(trustRes.reason.message);
    if (changedRes.status === "fulfilled") setWhatChanged(changedRes.value);
    // UI Enhancement Specs v2, §1 -- a trends fetch failure is silently
    // absent (no sparkline), never a page-level error; this is decorative,
    // not load-bearing data.
    if (trendsRes.status === "fulfilled") setTrends(trendsRes.value);
    if (tasksRes.status === "fulfilled") setOverdueTasks(tasksRes.value.tasks || []);
    if (invoicesRes.status === "fulfilled") setOverdueInvoices((invoicesRes.value.invoices || []).filter((inv) => inv.status === "OVERDUE"));
    if (stockRes.status === "fulfilled") setLowStockProducts(stockRes.value.products || []);
  }, [orgId]);

  useEffect(() => {
    load();
  }, [load]);

  const topBullets = (whatChanged?.sections || []).flatMap((s) => s.bullets).slice(0, 4);
  const attentionCount = (overdueTasks?.length || 0) + (overdueInvoices?.length || 0) + (lowStockProducts?.length || 0);
  const isDesktopApp = typeof window !== "undefined" && !!window.__TAURI__;

  return (
    <div className="space-y-6">
      {/* No local page title here -- the shell header (page.js) already
          shows "OS Home" + this same "Welcome back" line as its
          description, per BUSINESS_WORKSPACE_UX_AUDIT.md #3.2 (this used
          to render a second, competing <h1> independent of the shell's
          own title). Every other view in the Workspace defers to the
          shell header the same way. */}
      {error && <p className="text-[12px] text-red-400">{error}</p>}

      {/* Desktop app cross-promotion, merged in from the former separate
          "Dashboard" screen (see BUSINESS_WORKSPACE_UX_AUDIT.md #3.2 --
          OS Home and Dashboard were two redundant overview screens;
          consolidated into this one). Hidden when already inside the
          desktop app. */}
      {!isDesktopApp && (
        <div className="relative overflow-hidden bg-gradient-to-r from-[#00f2fe]/10 via-[#090d16] to-violet-500/10 border border-[var(--inaya-overlay-10)] rounded-2xl p-5 sm:p-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="pointer-events-none absolute -right-6 -top-6 opacity-40 hidden sm:block" aria-hidden="true">
            <AccentGraphic variant="business" size={120} />
          </div>
          <div className="relative">
            <span className="inline-block text-[12px] font-bold uppercase tracking-wide text-[#00f2fe] bg-[#00f2fe]/10 border border-[#00f2fe]/20 rounded-full px-2.5 py-1 mb-2">
              New · Desktop App
            </span>
            <h3 className="text-[var(--inaya-text-primary)] font-extrabold text-base sm:text-lg">🖥️ Business Workspace, now on your desktop</h3>
            <p className="text-[var(--inaya-text-muted)] text-xs sm:text-sm mt-1 max-w-lg">
              Runs in your system tray, notifies you when something needs your approval, and updates itself. Available for Windows and Linux.
            </p>
          </div>
          <div className="relative flex gap-2 shrink-0 w-full sm:w-auto">
            <a href="/business/download" className="flex-1 sm:flex-none text-center text-xs font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-violet-400 px-4 py-2.5 rounded-lg hover:brightness-110">
              Download
            </a>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <TrustHealthCard snapshot={trust} loading={!trust && !trustError} error={trustError} />
        <OsAssistantWidget orgId={orgId} />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Tile label="Departments" value={dashboard?.counts?.departments} onClick={() => onNavigate("departments")} />
        <Tile label="Projects" value={dashboard?.counts?.projects} onClick={() => onNavigate("projects")} />
        <Tile label="Documents" value={dashboard?.counts?.documents} onClick={() => onNavigate("documents")} />
        <Tile label="Pending approvals" value={dashboard?.pendingApprovals?.length} onClick={() => onNavigate("approvals")} trend={trends?.pendingApprovals} />
      </div>

      {/* Business Workspace UX/UI Makeover SOW §8 -- "Attention Required":
          real overdue tasks/invoices and low-stock items, from the same
          endpoints TasksView/FinanceView/InventoryView already use (never
          invented). Absent entirely for a caller with none of those three
          data sources visible to them, rather than an empty, confusing
          section. */}
      {attentionCount > 0 && (
        <div className="bg-[var(--inaya-surface)] border border-amber-400/20 rounded-2xl p-4">
          <p className="text-xs font-bold uppercase tracking-wide text-amber-400 mb-3">⚠ Attention Required</p>
          <div className="space-y-2">
            {overdueInvoices?.length > 0 && (
              <button onClick={() => onNavigate("finance")} className="w-full flex items-center justify-between gap-3 bg-black/20 border border-white/5 rounded-lg p-3 text-left hover:bg-white/5">
                <span className="text-[var(--inaya-text-primary)] text-sm">{overdueInvoices.length} overdue invoice{overdueInvoices.length === 1 ? "" : "s"}</span>
                <span className="text-[12px] font-mono text-red-400 shrink-0">
                  {formatCurrency(overdueInvoices.reduce((sum, inv) => sum + (Number(inv.total) || 0), 0), overdueInvoices[0]?.currency)}
                </span>
              </button>
            )}
            {lowStockProducts?.length > 0 && (
              <button onClick={() => onNavigate("inventory")} className="w-full flex items-center justify-between gap-3 bg-black/20 border border-white/5 rounded-lg p-3 text-left hover:bg-white/5">
                <span className="text-[var(--inaya-text-primary)] text-sm">{lowStockProducts.length} product{lowStockProducts.length === 1 ? "" : "s"} low on stock</span>
                <span className="text-[12px] font-mono text-amber-400 shrink-0">Reorder soon</span>
              </button>
            )}
            {overdueTasks?.length > 0 && (
              <button onClick={() => onNavigate("tasks")} className="w-full flex items-center justify-between gap-3 bg-black/20 border border-white/5 rounded-lg p-3 text-left hover:bg-white/5">
                <span className="text-[var(--inaya-text-primary)] text-sm">{overdueTasks.length} overdue task{overdueTasks.length === 1 ? "" : "s"}</span>
                <span className="text-[12px] font-mono text-red-400 shrink-0">Past due</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* SOW §8 -- "Quick actions": jumps straight to the module that owns
          the action (each module's own "+ New" button opens the real
          create form there) -- not a fabricated shortcut, since opening a
          specific module's create modal from here would need new
          cross-component wiring this pass didn't build. */}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-4">
        <p className="text-xs font-bold uppercase tracking-wide text-[var(--inaya-text-muted)] mb-3">Quick Actions</p>
        <div className="flex flex-wrap gap-2">
          {[
            ["finance", "+ Invoice"],
            ["procurement", "+ Purchase Order"],
            ["crm", "+ Customer"],
            ["tasks", "+ Task"],
            ["documents", "+ Upload Document"],
            ["finance", "+ Expense"],
          ].map(([view, label], i) => (
            <button key={i} onClick={() => onNavigate(view)} className="text-[12px] font-bold text-[var(--inaya-text-primary)] bg-white/5 hover:bg-white/10 border border-white/10 rounded-full px-3.5 py-2">
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-4">
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-bold uppercase tracking-wide text-[var(--inaya-text-muted)]">What Changed? — This Week</p>
          <button onClick={() => onNavigate("whatChanged")} className="text-[11px] font-bold text-[#00f2fe]">
            View all →
          </button>
        </div>
        {topBullets.length === 0 ? (
          <EmptyState compact icon="🌤️" description="Quiet week — nothing new to report yet." />
        ) : (
          <ul className="relative space-y-3 pl-4 border-l border-white/10">
            {topBullets.map((b, i) => (
              <li key={i} className="relative text-[13px] text-[var(--inaya-text-primary)]">
                <span className="absolute -left-[21px] top-1 w-2 h-2 rounded-full bg-[#00f2fe] shadow-[0_0_6px_rgba(0,242,254,0.7)]" />
                <span>{b}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <PermissionsSummary />

      {/* Merged in from the former separate "Dashboard" screen -- see the
          desktop-promo comment above for why. Real drill-down data,
          already fetched into `dashboard` above; nothing new invented. */}
      {(dashboard?.recentDepartments?.length > 0 || dashboard?.recentProjects?.length > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-4">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-bold uppercase tracking-wide text-[var(--inaya-text-muted)]">Recent Departments</p>
              <button onClick={() => onNavigate("departments")} className="text-[11px] font-bold text-[#00f2fe]">View all →</button>
            </div>
            {dashboard.recentDepartments.length === 0 ? (
              <EmptyState compact icon="🏢" description="No departments yet." ctaLabel="Create one" onCta={() => onNavigate("departments")} />
            ) : (
              <div className="space-y-1">
                {dashboard.recentDepartments.map((d) => (
                  <button key={d.id} onClick={() => onNavigate("projects", { deptId: d.id })} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-[var(--inaya-overlay-5)] text-left">
                    <div className="w-8 h-8 rounded-lg bg-[var(--inaya-overlay-5)] flex items-center justify-center shrink-0">
                      <Icon path={ICONS.departments} className="w-4 h-4 text-[var(--inaya-text-muted)]" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-[var(--inaya-text-primary)] text-xs font-bold truncate">{d.name}</p>
                      <p className="text-[var(--inaya-text-muted)] text-[12px] font-mono">{d.projectCount} project{d.projectCount === 1 ? "" : "s"}</p>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-4">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-bold uppercase tracking-wide text-[var(--inaya-text-muted)]">Recent Projects</p>
              <button onClick={() => onNavigate("projects")} className="text-[11px] font-bold text-[#00f2fe]">View all →</button>
            </div>
            {dashboard.recentProjects.length === 0 ? (
              <EmptyState compact icon="📁" description="No projects yet." ctaLabel="Create one" onCta={() => onNavigate("projects")} />
            ) : (
              <div className="space-y-1">
                {dashboard.recentProjects.map((p) => (
                  <button key={p.id} onClick={() => onNavigate("documents", { deptId: p.departmentId, projectId: p.id })} className="w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-lg hover:bg-[var(--inaya-overlay-5)] text-left">
                    <div className="min-w-0">
                      <p className="text-[var(--inaya-text-primary)] text-xs font-bold truncate">{p.name}</p>
                      <p className="text-[var(--inaya-text-muted)] text-[12px] font-mono truncate">{p.departmentName} · {p.documentCount} document{p.documentCount === 1 ? "" : "s"}</p>
                    </div>
                    <span className="flex items-center gap-1 text-[11px] font-bold uppercase text-emerald-400 shrink-0">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /> Active
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <div>
        <p className="text-xs font-bold uppercase tracking-wide text-[var(--inaya-text-muted)] mb-2">Trust &amp; Audit</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <LinkTile
            label="Audit Trail"
            description="Cryptographically hash-chained, self-service verifiable."
            onClick={() => onNavigate("auditTrail")}
            popOutPath="/business?view=auditTrail"
          />
          {can.manageOrg() && (
            <LinkTile
              label="AI Action Requests"
              description="Review AI-proposed changes awaiting approval."
              onClick={() => onNavigate("aiActions")}
              popOutPath="/business?view=aiActions"
            />
          )}
        </div>
      </div>
    </div>
  );
}
