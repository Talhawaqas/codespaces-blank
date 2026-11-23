"use client";

// src/components/business/admin/AdminDashboardView.js -- the enterprise admin overview (Competitive Expansion SOW U). Every tile shows a real value or an
// honest state: NO DATA, NOT ENABLED or UNKNOWN with the coverage limitation. Nothing is estimated.
import { useCallback, useEffect, useState } from "react";
import EmptyState from "../../EmptyState";

const card = "bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] rounded-lg";
const muted = "text-[var(--inaya-text-muted)]";
const STATE = { OK: "text-emerald-400 border-emerald-400/30", ATTENTION: "text-amber-300 border-amber-400/40", NO_DATA: "text-slate-300 border-slate-400/30", NOT_ENABLED: "text-slate-400 border-slate-500/30", UNKNOWN: "text-sky-300 border-sky-400/30" };
// Sentence case for the honest states (modern look, owner-approved 22 Nov 2026); the meaning is unchanged.
const STATE_LABEL = { OK: "OK", ATTENTION: "Needs attention", NO_DATA: "No data", NOT_ENABLED: "Not enabled", UNKNOWN: "Unknown" };
const fmt = (t) => {
  if (t.value == null) return STATE_LABEL[t.state] || "—";
  if (t.unit === "bytes") { const u = ["B", "KB", "MB", "GB", "TB"]; let v = Number(t.value), i = 0; while (v >= 1024 && i < 4) { v /= 1024; i++; } return `${v.toFixed(i ? 1 : 0)} ${u[i]}`; }
  return String(t.value);
};

// Privacy-safe usage counters (OBS-001): counts and states only, from /api/orgs/metrics. A name with no data means nobody reported it, not zero.
function UsageMetrics({ orgId }) {
  const [m, setM] = useState(null); const [err, setErr] = useState("");
  useEffect(() => { let off = false; fetch(`/api/orgs/metrics?orgId=${orgId}&days=7`, { credentials: "include" }).then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error || "Could not load."); if (!off) setM(d); }).catch((e) => { if (!off) setErr(e.message); }); return () => { off = true; }; }, [orgId]);
  if (err) return <p className={`text-[11px] ${muted}`}>Usage metrics unavailable: {err}</p>;
  if (!m) return null;
  const rows = Object.entries(m.counters || {});
  return (
    <div className={`${card} p-3`}>
      <p className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)]">Usage, last {m.days} days</p>
      {rows.length === 0 ? <p className={`text-[12px] ${muted} mt-1`}>No usage recorded yet.</p> : <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-1 mt-2">{rows.map(([k, v]) => <p key={k} className="text-[12px] flex justify-between gap-2"><span className={muted}>{v.help || k}</span><b>{v.total}</b></p>)}</div>}
      <p className={`text-[10px] ${muted} mt-2`}>{m.privacy} {(m.notCollected || [])[0]}</p>
    </div>
  );
}

// Modern layout (owner-approved mockup, 22 Nov 2026): summary tiles that filter, live figures first, a "Turn on more protection"
// list with a Turn on action, and a quiet list for things waiting for their first data. Same data and honest states as before.
const GROUPS = [
  { key: "all", label: "All", dot: "#94a3b8" },
  { key: "OK", label: "Healthy", dot: "#10b981" },
  { key: "ATTENTION", label: "Needs attention", dot: "#f59e0b" },
  { key: "NO_DATA", label: "No data yet", dot: "#94a3b8" },
  { key: "NOT_ENABLED", label: "Not turned on", dot: "#64748b" },
  { key: "UNKNOWN", label: "Can't be measured", dot: "#38bdf8" },
];
const Pill = ({ state }) => <span className={`text-[11px] font-semibold border rounded-full px-2 py-0.5 whitespace-nowrap ${STATE[state]}`}>{STATE_LABEL[state] || state}</span>;
const SectionTitle = ({ children, count }) => <h3 className="text-[15px] font-semibold text-[var(--inaya-text-primary)] flex items-center gap-2">{children}{count != null && <span className={`text-[12px] font-normal ${muted}`}>{count}</span>}</h3>;

export default function AdminDashboardView({ orgId, onNavigate }) {
  const [data, setData] = useState(null); const [err, setErr] = useState(""); const [filter, setFilter] = useState("all");
  const load = useCallback(async () => { try { const r = await fetch(`/api/orgs/admin-dashboard?orgId=${orgId}`, { credentials: "include" }); const d = await r.json(); if (!r.ok) throw new Error(d.error || "Could not load."); setData(d); setErr(""); } catch (e) { setErr(e.message); } }, [orgId]);
  useEffect(() => { load(); }, [load]);
  if (err) return <EmptyState title="Admin dashboard" description={err} />;
  if (!data) return <p className={`text-[12px] ${muted}`}>Loading…</p>;
  const tiles = data.tiles;
  const count = (k) => (k === "all" ? tiles.length : tiles.filter((t) => t.state === k).length);
  const show = (k) => filter === "all" || filter === k;
  const live = tiles.filter((t) => (t.state === "OK" || t.state === "ATTENTION") && show(t.state)).sort((a, b) => (a.state === "ATTENTION" ? -1 : 0) - (b.state === "ATTENTION" ? -1 : 0));
  const off = show("NOT_ENABLED") ? tiles.filter((t) => t.state === "NOT_ENABLED") : [];
  const waiting = tiles.filter((t) => (t.state === "NO_DATA" && show("NO_DATA")) || (t.state === "UNKNOWN" && show("UNKNOWN")));
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        {GROUPS.map((g) => { const n = count(g.key); const on = filter === g.key; return (
          <button key={g.key} type="button" aria-pressed={on} onClick={() => setFilter(g.key)} disabled={!n && g.key !== "all"}
            className={`${card} px-3.5 py-2 text-left min-w-[118px] transition disabled:opacity-40 ${on ? "ring-2 ring-[var(--inaya-accent)] border-transparent" : "hover:border-[var(--inaya-accent)]"}`}>
            <span className="flex items-center gap-1.5 text-[12px] text-[var(--inaya-text-muted)]"><span className="w-2 h-2 rounded-full" style={{ background: g.dot }} />{g.label}</span>
            <span className="block text-[22px] font-semibold leading-tight text-[var(--inaya-text-primary)]">{n}</span>
          </button>); })}
        <span className={`ml-auto text-[12px] ${muted}`}>Updated {new Date(data.generatedAt).toLocaleTimeString()} · <button className="underline" onClick={load}>Refresh</button></span>
      </div>

      {live.length > 0 && <section className="space-y-2">
        <SectionTitle count={live.length}>Live now</SectionTitle>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {live.map((t) => (
            <div key={t.id} className={`${card} p-4 ${t.state === "ATTENTION" ? "border-amber-400/50" : ""}`}>
              <div className="flex items-start justify-between gap-2"><p className="text-[13px] font-medium text-[var(--inaya-text-muted)]">{t.label}</p><Pill state={t.state} /></div>
              <p className="text-[28px] font-semibold leading-tight mt-1 text-[var(--inaya-text-primary)]">{fmt(t)}</p>
              {t.detail && <p className="text-[13px] text-[var(--inaya-text-primary)]">{t.detail}</p>}
              {t.note && <p className={`text-[12px] ${muted} mt-1.5`}>{t.note}</p>}
            </div>))}
        </div>
      </section>}

      {off.length > 0 && <section className="space-y-2">
        <SectionTitle count={off.length}>Turn on more protection</SectionTitle>
        <div className={`${card} divide-y divide-[var(--inaya-overlay-10)]`}>
          {off.map((t) => (
            <div key={t.id} className="flex items-center gap-3 px-4 py-3">
              <span className="w-2 h-2 rounded-full bg-slate-400 shrink-0" />
              <div className="min-w-0 flex-1"><p className="text-[14px] font-medium text-[var(--inaya-text-primary)]">{t.label}</p>{t.note && <p className={`text-[12px] ${muted}`}>{t.note}</p>}</div>
              {onNavigate && <button type="button" onClick={() => onNavigate("settings")} className="shrink-0 text-[13px] font-semibold px-3 py-1.5 rounded-lg bg-[var(--inaya-accent)] text-[var(--inaya-on-accent)]">Turn on</button>}
            </div>))}
        </div>
      </section>}

      {waiting.length > 0 && <section className="space-y-2">
        <SectionTitle count={waiting.length}>Waiting for first data</SectionTitle>
        <div className={`${card} grid sm:grid-cols-2 gap-x-6`}>
          {waiting.map((t) => (
            <div key={t.id} className="flex items-start justify-between gap-3 px-4 py-2.5 border-b border-[var(--inaya-overlay-10)]">
              <div className="min-w-0"><p className="text-[13px] font-medium text-[var(--inaya-text-primary)]">{t.label}</p>{t.note && <p className={`text-[12px] ${muted}`}>{t.note}</p>}</div>
              <Pill state={t.state} />
            </div>))}
        </div>
      </section>}

      {!live.length && !off.length && !waiting.length && <p className={`text-[13px] ${muted}`}>Nothing in this group.</p>}
      <UsageMetrics orgId={orgId} />
    </div>
  );
}
