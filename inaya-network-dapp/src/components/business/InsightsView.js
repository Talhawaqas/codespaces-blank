"use client";

// src/components/business/InsightsView.js
//
// Business Insights & KPI Dashboard — executive overview, trend charts,
// business alerts, and a drill-down link per alert into the source
// module's own view. Backed by GET /api/orgs/insights, which is just
// business-insights.js's computeBusinessInsights() over the same
// permission-scoped data every other Business Workspace view already
// reads — nothing here is a separate, weaker-scoped data path.
//
// Charts are small hand-rolled inline SVG (bar/line), not a charting
// library — consistent with this codebase's "hand-roll small utilities"
// convention (see e.g. finance/reports' CSV builder) and there's nothing
// here complex enough to justify a new dependency.

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../EmptyState";

async function api(path) {
  const res = await fetch(path);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

const PERIOD_OPTIONS = [["7", "7 days"], ["30", "30 days"], ["90", "90 days"]];
const SEVERITY_STYLE = {
  high: "bg-red-400/10 text-red-400 border-red-400/30",
  medium: "bg-amber-400/10 text-amber-400 border-amber-400/30",
  low: "bg-[#00f2fe]/10 text-[#00f2fe] border-[#00f2fe]/30",
};
const CURRENCY_KEYS = new Set(["revenue", "expenses", "pipelineValue"]);

function formatKpiValue(key, value) {
  if (CURRENCY_KEYS.has(key)) return `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  if (key === "winRate" || key === "taskCompletionRate") return `${value}%`;
  return value.toLocaleString();
}

export default function InsightsView({ orgId, canManage, onNavigate }) {
  const [periodDays, setPeriodDays] = useState("30");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  // "approvals" is a manage-only view — a non-manager can still see a
  // pending-approvals alert (department-level visibility, not manager-only),
  // so route their click somewhere that actually renders instead of a
  // silently-gated blank view.
  const drillTo = (target) => onNavigate?.(target === "approvals" && !canManage ? "dashboard" : target);

  const load = useCallback(async () => {
    try {
      setData(await api(`/api/orgs/insights?orgId=${orgId}&periodDays=${periodDays}`));
    } catch (err) {
      setError(err.message);
    }
  }, [orgId, periodDays]);

  useEffect(() => { load(); }, [load]);

  if (error) return <p className="text-red-400 text-xs">{error}</p>;
  if (!data) return <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>;

  const noDataYet = Object.values(data.kpis).every((kpi) => !kpi.value) && data.alerts.length === 0;
  if (noDataYet) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)]">Period</span>
          <div className="flex bg-[var(--inaya-surface)] border border-white/5 rounded-xl p-1">
            {PERIOD_OPTIONS.map(([value, label]) => (
              <button key={value} onClick={() => setPeriodDays(value)} className={`px-3 py-1.5 text-xs font-bold rounded-lg ${periodDays === value ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>{label}</button>
            ))}
          </div>
        </div>
        <EmptyState icon="📊" title="Not enough data yet" description="Insights build up as your team creates tasks, deals, invoices, and expenses. Check back once there's some activity to summarize." />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)]">Period</span>
        <div className="flex bg-[var(--inaya-surface)] border border-white/5 rounded-xl p-1">
          {PERIOD_OPTIONS.map(([value, label]) => (
            <button key={value} onClick={() => setPeriodDays(value)} className={`px-3 py-1.5 text-xs font-bold rounded-lg ${periodDays === value ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>{label}</button>
          ))}
        </div>
      </div>

      {data.alerts.length > 0 && (
        <div className="space-y-2">
          <p className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)]">Business Alerts</p>
          {data.alerts.map((a, i) => (
            <button
              key={i}
              onClick={() => drillTo(a.drillTo)}
              className={`w-full flex items-center justify-between gap-3 rounded-xl border px-4 py-2.5 text-left text-xs font-semibold ${SEVERITY_STYLE[a.severity] || SEVERITY_STYLE.low}`}
            >
              <span>{a.message}</span>
              <span className="text-[10px] uppercase opacity-70 shrink-0">View →</span>
            </button>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {Object.entries(data.kpis).map(([key, kpi]) => (
          <div key={key} className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-4">
            <p className="text-[#8a96ab] text-[11px] font-mono mb-1">{kpi.label}</p>
            <p className="text-[var(--inaya-text-primary)] text-xl font-bold tabular-nums">{formatKpiValue(key, kpi.value)}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <ComparisonCard title="Revenue" comparison={data.comparison.revenue} currency />
        <ComparisonCard title="Expenses" comparison={data.comparison.expenses} currency />
        <ComparisonCard title="Deals Won" comparison={data.comparison.dealsWon} />
        <ComparisonCard title="Tasks Completed" comparison={data.comparison.tasksCompleted} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <TrendChart title="Revenue" series={data.trends.revenue} color="#00f2fe" currency />
        <TrendChart title="Expenses" series={data.trends.expenses} color="#f87171" currency />
        <TrendChart title="Tasks Completed / Day" series={data.trends.tasksCompleted} color="#4facfe" />
        <TrendChart title="Deals Won Value / Day" series={data.trends.dealsWon} color="#34d399" currency />
      </div>

      {(data.overdueInvoices.length > 0 || data.overdueTasks.length > 0 || data.lowStockProducts.length > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {data.overdueInvoices.length > 0 && (
            <DrillList title="Overdue Invoices" onView={() => onNavigate?.("finance")}>
              {data.overdueInvoices.map((i, idx) => <li key={idx} className="flex justify-between"><span>{i.invoiceNumber}</span><span className="font-mono">${i.total.toFixed(0)}</span></li>)}
            </DrillList>
          )}
          {data.overdueTasks.length > 0 && (
            <DrillList title="Overdue Tasks" onView={() => onNavigate?.("tasks")}>
              {data.overdueTasks.map((t, idx) => <li key={idx} className="truncate">{t.title}</li>)}
            </DrillList>
          )}
          {data.lowStockProducts.length > 0 && (
            <DrillList title="Low Stock" onView={() => onNavigate?.("inventory")}>
              {data.lowStockProducts.map((p, idx) => <li key={idx} className="flex justify-between"><span className="truncate">{p.name}</span><span className="font-mono">{p.totalStock}</span></li>)}
            </DrillList>
          )}
        </div>
      )}

      {data.alerts.length === 0 && (
        <EmptyState compact icon="✅" description="No active business alerts — everything's within normal range." />
      )}
    </div>
  );
}

function ComparisonCard({ title, comparison, currency }) {
  const up = comparison.changePct >= 0;
  const fmt = (v) => (currency ? `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : v.toLocaleString());
  return (
    <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-4">
      <p className="text-[#8a96ab] text-[11px] font-mono mb-1">{title} vs. prior period</p>
      <div className="flex items-baseline gap-2">
        <span className="text-[var(--inaya-text-primary)] text-lg font-bold tabular-nums">{fmt(comparison.current)}</span>
        <span className={`text-xs font-bold ${up ? "text-emerald-400" : "text-red-400"}`}>{up ? "▲" : "▼"} {Math.abs(comparison.changePct)}%</span>
      </div>
      <p className="text-[#8a96ab] text-[11px] font-mono mt-0.5">Prior: {fmt(comparison.previous)}</p>
    </div>
  );
}

function TrendChart({ title, series, color, currency }) {
  const width = 280;
  const height = 72;
  const max = Math.max(1, ...series.map((p) => p.value));
  const stepX = series.length > 1 ? width / (series.length - 1) : width;
  const points = series.map((p, i) => `${i * stepX},${height - (p.value / max) * height}`).join(" ");
  const total = series.reduce((s, p) => s + p.value, 0);

  return (
    <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-4">
      <div className="flex items-center justify-between mb-2">
        <p className="text-[#8a96ab] text-[11px] font-mono">{title}</p>
        <p className="text-[var(--inaya-text-primary)] text-xs font-bold tabular-nums">{currency ? `$${total.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : total.toLocaleString()}</p>
      </div>
      {series.length === 0 || total === 0 ? (
        <p className="text-[#8a96ab] text-xs italic py-4">No activity in this period.</p>
      ) : (
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-16" preserveAspectRatio="none">
          <polyline points={points} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
        </svg>
      )}
    </div>
  );
}

function DrillList({ title, onView, children }) {
  return (
    <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-4">
      <div className="flex items-center justify-between mb-2">
        <p className="text-[#8a96ab] text-[11px] font-bold uppercase">{title}</p>
        <button onClick={onView} className="text-[#00f2fe] text-[11px] font-bold">View →</button>
      </div>
      <ul className="text-[var(--inaya-text-primary)] text-xs space-y-1">{children}</ul>
    </div>
  );
}
