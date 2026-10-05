"use client";

// src/components/business/admin/AdminDashboardView.js -- the enterprise admin overview (Competitive Expansion SOW U). Every tile shows a real value or an
// honest state: NO DATA, NOT ENABLED or UNKNOWN with the coverage limitation. Nothing is estimated.
import { useCallback, useEffect, useState } from "react";
import EmptyState from "../../EmptyState";

const card = "bg-[var(--inaya-overlay-5)] border border-[var(--inaya-overlay-10)] rounded-lg";
const muted = "text-[var(--inaya-text-muted)]";
const STATE = { OK: "text-emerald-400 border-emerald-400/30", ATTENTION: "text-amber-300 border-amber-400/40", NO_DATA: "text-slate-300 border-slate-400/30", NOT_ENABLED: "text-slate-400 border-slate-500/30", UNKNOWN: "text-sky-300 border-sky-400/30" };
const fmt = (t) => {
  if (t.value == null) return { NO_DATA: "NO DATA", NOT_ENABLED: "NOT ENABLED", UNKNOWN: "UNKNOWN" }[t.state] || "—";
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

export default function AdminDashboardView({ orgId }) {
  const [data, setData] = useState(null); const [err, setErr] = useState("");
  const load = useCallback(async () => { try { const r = await fetch(`/api/orgs/admin-dashboard?orgId=${orgId}`, { credentials: "include" }); const d = await r.json(); if (!r.ok) throw new Error(d.error || "Could not load."); setData(d); setErr(""); } catch (e) { setErr(e.message); } }, [orgId]);
  useEffect(() => { load(); }, [load]);
  if (err) return <EmptyState title="Admin dashboard" description={err} />;
  if (!data) return <p className={`text-[12px] ${muted}`}>Loading…</p>;
  return (
    <div className="space-y-3">
      <p className={`text-[12px] ${muted}`}>{data.summary.attention} need attention · {data.summary.noData} have no data yet · {data.summary.notEnabled} not enabled · {data.summary.unknown} cannot be measured. Updated {new Date(data.generatedAt).toLocaleTimeString()}. <button className="underline" onClick={load}>Refresh</button></p>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {data.tiles.map((t) => (
          <div key={t.id} className={`${card} p-3`}>
            <div className="flex items-start justify-between gap-2"><p className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)]">{t.label}</p><span className={`text-[10px] font-bold uppercase border rounded-full px-2 py-0.5 ${STATE[t.state]}`}>{t.state.replace("_", " ")}</span></div>
            <p className={`text-xl font-bold mt-1 ${t.value == null ? "text-[var(--inaya-text-muted)] text-sm" : ""}`}>{fmt(t)}</p>
            {t.detail && <p className="text-[12px]">{t.detail}</p>}{t.note && <p className={`text-[11px] ${muted} mt-1`}>{t.note}</p>}
          </div>))}
      </div>
      <UsageMetrics orgId={orgId} />
    </div>
  );
}
