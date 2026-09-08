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
import { TileIcon } from "./tileIcons";
import { useCountUp } from "../../hooks/useCountUp";

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
  const { orgId, orgName, can } = useOrg();
  const [dashboard, setDashboard] = useState(null);
  const [trust, setTrust] = useState(null);
  const [trustError, setTrustError] = useState("");
  const [whatChanged, setWhatChanged] = useState(null);
  const [trends, setTrends] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    const [dashRes, trustRes, changedRes, trendsRes] = await Promise.allSettled([
      api(`/api/orgs/dashboard?orgId=${orgId}`),
      api(`/api/orgs/trust-health?orgId=${orgId}`),
      api(`/api/orgs/activity-center?orgId=${orgId}&period=weekly`),
      api(`/api/orgs/dashboard-trends?orgId=${orgId}`),
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
  }, [orgId]);

  useEffect(() => {
    load();
  }, [load]);

  const topBullets = (whatChanged?.sections || []).flatMap((s) => s.bullets).slice(0, 4);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-extrabold bg-clip-text text-transparent bg-gradient-to-r from-[var(--inaya-text-primary)] to-[#00f2fe]">Welcome back — {orgName}</h1>
        <p className="text-[13px] text-[var(--inaya-text-muted)] mt-0.5">One place for what's happening across your organization.</p>
      </div>

      {error && <p className="text-[12px] text-red-400">{error}</p>}

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
