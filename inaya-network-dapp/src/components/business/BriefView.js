"use client";

// src/components/business/BriefView.js
//
// Daily / Weekly / Monthly / Yearly Brief — a periodic recap backed by
// GET /api/orgs/brief, which is business-brief.js's generateBusinessBrief()
// over the same permission-scoped data InsightsView already reads. The
// narrative paragraph is best-effort (may be null if Gemini isn't
// configured or the call failed) — the highlights bullets are always the
// real, deterministic numbers regardless, same "don't let an AI call
// block the real data" discipline as the rest of this codebase.

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../EmptyState";

async function api(path) {
  const res = await fetch(path);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

const PERIOD_OPTIONS = [
  ["daily", "Daily"],
  ["weekly", "Weekly"],
  ["monthly", "Monthly"],
  ["yearly", "Yearly"],
];

const SEVERITY_STYLE = {
  high: "bg-red-400/10 text-red-400 border-red-400/30",
  medium: "bg-amber-400/10 text-amber-400 border-amber-400/30",
  low: "bg-[#00f2fe]/10 text-[#00f2fe] border-[#00f2fe]/30",
};

export default function BriefView({ orgId }) {
  const [period, setPeriod] = useState("weekly");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setData(null);
    try {
      setData(await api(`/api/orgs/brief?orgId=${orgId}&period=${period}`));
    } catch (err) {
      setError(err.message);
    }
  }, [orgId, period]);

  useEffect(() => { load(); }, [load]);

  const periodSelector = (
    <div className="flex items-center gap-2">
      <span className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)]">Period</span>
      <div className="flex bg-[var(--inaya-surface)] border border-white/5 rounded-xl p-1">
        {PERIOD_OPTIONS.map(([value, label]) => (
          <button
            key={value}
            onClick={() => setPeriod(value)}
            className={`px-3 py-1.5 text-xs font-bold rounded-lg ${period === value ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );

  if (error) return <div className="space-y-4">{periodSelector}<p className="text-red-400 text-xs">{error}</p></div>;
  if (!data) {
    return (
      <div className="space-y-4">
        {periodSelector}
        <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Generating brief…</p>
      </div>
    );
  }

  const noDataYet = data.highlights.length === 0 && data.alerts.length === 0;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-[var(--inaya-text-primary)] font-bold text-sm">Business Brief</h3>
        <p className="text-[var(--inaya-text-muted)] text-xs mt-0.5">A real recap of this {period === "daily" ? "day" : period === "weekly" ? "week" : period === "monthly" ? "month" : "year"}, compared to the equivalent previous period.</p>
      </div>

      {periodSelector}

      {noDataYet ? (
        <EmptyState icon="📰" title="Not enough data yet" description="Briefs build up as your team creates tasks, deals, invoices, and expenses. Check back once there's some activity to summarize." />
      ) : (
        <>
          {data.summary && (
            <div className="bg-[#00f2fe]/5 border border-[#00f2fe]/20 rounded-2xl p-5">
              <p className="text-[var(--inaya-text-primary)] text-sm leading-relaxed">{data.summary}</p>
            </div>
          )}

          <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
            <h4 className="text-[var(--inaya-text-primary)] font-bold text-xs uppercase mb-3">Highlights</h4>
            <ul className="space-y-2">
              {data.highlights.map((h, i) => (
                <li key={i} className="text-[var(--inaya-text-primary)] text-sm flex gap-2">
                  <span className="text-[var(--inaya-text-muted)]">•</span>
                  <span>{h}</span>
                </li>
              ))}
            </ul>
          </div>

          {data.alerts.length > 0 && (
            <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
              <h4 className="text-[var(--inaya-text-primary)] font-bold text-xs uppercase mb-3">Alerts</h4>
              <div className="space-y-2">
                {data.alerts.map((a, i) => (
                  <div key={i} className={`text-xs font-bold px-3 py-2 rounded-lg border ${SEVERITY_STYLE[a.severity] || ""}`}>
                    {a.message}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      <p className="text-[var(--inaya-text-muted)] text-[11px] font-mono">Generated {new Date(data.generatedAt).toLocaleString()}</p>
    </div>
  );
}
