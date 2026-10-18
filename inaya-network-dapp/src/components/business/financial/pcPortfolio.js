"use client";

// src/components/business/financial/pcPortfolio.js — PRIVATE CAPITAL: PORTFOLIO COMPANIES (Phase 3, §35-39 — board, value creation, KPIs/monitoring, all attached to a portfolio company)
// Moved verbatim from FinancialView.js (Business Workspace gap closure, Batch 3).

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../../EmptyState";
import { Empty, api } from "./shared.js";

// ============================================================
// PRIVATE CAPITAL: PORTFOLIO COMPANIES (Phase 3, §35-39 — board, value
// creation, KPIs/monitoring, all attached to a portfolio company)
// ============================================================
export function PrivateCapitalPortfolioTab({ orgId }) {
  const [companies, setCompanies] = useState(null);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setError("");
      setCompanies((await api(`/api/orgs/private-capital/portfolio-companies?orgId=${orgId}`)).portfolioCompanies);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  if (!companies) return <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>;

  return (
    <div className="space-y-4">
      {error && <p className="text-red-400 text-xs">{error}</p>}
      {companies.length === 0 ? (
        <EmptyState compact icon="🏢" description="No portfolio companies yet. Convert a CLOSING deal from the Deals tab to create one." />
      ) : (
        <div className="flex flex-wrap gap-2">
          {companies.map((c) => (
            <button key={c.id} onClick={() => setSelected(c.id)} className={`text-[11px] font-bold px-3 py-1.5 rounded-lg border ${selected === c.id ? "bg-[#00f2fe]/15 text-[#00f2fe] border-[#00f2fe]/30" : "text-[var(--inaya-text-muted)] border-white/10"}`}>{c.name} <span className="opacity-60">({c.status})</span></button>
          ))}
        </div>
      )}
      {selected && <PortfolioCompanyWorkspace orgId={orgId} portfolioCompanyId={selected} />}
    </div>
  );
}

export function PortfolioCompanyWorkspace({ orgId, portfolioCompanyId }) {
  const [section, setSection] = useState("board");
  return (
    <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5 space-y-3">
      <div className="flex gap-1 flex-wrap border-b border-white/5 pb-2">
        {["board", "value creation", "kpis", "cap table"].map((s) => (
          <button key={s} onClick={() => setSection(s)} className={`text-[10px] font-bold uppercase px-2 py-1 rounded ${section === s ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>{s}</button>
        ))}
      </div>
      {section === "board" && <BoardSection orgId={orgId} portfolioCompanyId={portfolioCompanyId} />}
      {section === "value creation" && <ValueCreationSection orgId={orgId} portfolioCompanyId={portfolioCompanyId} />}
      {section === "kpis" && <KpiSection orgId={orgId} portfolioCompanyId={portfolioCompanyId} />}
      {section === "cap table" && <CapTableSection orgId={orgId} portfolioCompanyId={portfolioCompanyId} />}
    </div>
  );
}

export function BoardSection({ orgId, portfolioCompanyId }) {
  const [meetings, setMeetings] = useState(null);
  const [scheduledAt, setScheduledAt] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setError("");
      setMeetings((await api(`/api/orgs/private-capital/portfolio-companies/${portfolioCompanyId}/board-meetings?orgId=${orgId}`)).meetings);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId, portfolioCompanyId]);

  useEffect(() => { load(); }, [load]);

  async function schedule(e) {
    e.preventDefault();
    if (!scheduledAt) return;
    try {
      setError("");
      await api(`/api/orgs/private-capital/portfolio-companies/${portfolioCompanyId}/board-meetings`, { method: "POST", body: JSON.stringify({ orgId, scheduledAt: new Date(scheduledAt).toISOString() }) });
      setScheduledAt("");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function advance(meetingId, action, extra) {
    try {
      setError("");
      await api(`/api/orgs/private-capital/board-meetings/${meetingId}`, { method: "PATCH", body: JSON.stringify({ orgId, action, ...extra }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  const NEXT = { SCHEDULED: ["setAgenda", { agendaItems: ["Financial update"] }], AGENDA_SET: ["hold", { attendees: [] }], HELD: ["draftMinutes", { minutesText: "Minutes recorded." }], MINUTES_DRAFTED: ["approveMinutes", {}] };

  return (
    <div className="space-y-2">
      <form onSubmit={schedule} className="flex flex-wrap gap-2">
        <input value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} type="datetime-local" className="bg-black/45 border border-white/15 rounded-lg px-2 py-1 text-[10px] text-[var(--inaya-text-primary)]" />
        <button disabled={!scheduledAt} className="text-[10px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-2.5 py-1 rounded-lg disabled:opacity-40">Schedule meeting</button>
      </form>
      {error && <p className="text-red-400 text-[10px]">{error}</p>}
      {!meetings || meetings.length === 0 ? <Empty /> : meetings.map((m) => (
        <div key={m.id} className="bg-black/20 border border-white/5 rounded-lg p-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-[var(--inaya-text-muted)]">{new Date(m.scheduledAt).toLocaleString()} <span className="font-mono">[{m.status}]</span></span>
            {NEXT[m.status] && <button onClick={() => advance(m.id, NEXT[m.status][0], NEXT[m.status][1])} className="text-[10px] font-bold uppercase text-[#00f2fe] shrink-0">{NEXT[m.status][0]}</button>}
          </div>
          {m.status === "MINUTES_APPROVED" && <ResolutionsSection orgId={orgId} meetingId={m.id} />}
        </div>
      ))}
    </div>
  );
}

export function ResolutionsSection({ orgId, meetingId }) {
  const [resolutions, setResolutions] = useState(null);
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setError("");
      setResolutions((await api(`/api/orgs/private-capital/board-meetings/${meetingId}/resolutions?orgId=${orgId}`)).resolutions);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId, meetingId]);

  useEffect(() => { load(); }, [load]);

  async function propose(e) {
    e.preventDefault();
    if (!title.trim()) return;
    try {
      setError("");
      await api(`/api/orgs/private-capital/board-meetings/${meetingId}/resolutions`, { method: "POST", body: JSON.stringify({ orgId, title: title.trim() }) });
      setTitle("");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function vote(resolutionId, v) {
    try {
      setError("");
      await api(`/api/orgs/private-capital/resolutions/${resolutionId}/vote`, { method: "POST", body: JSON.stringify({ orgId, voterEmail: "director@example.com", vote: v }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function close(resolutionId) {
    try {
      setError("");
      await api(`/api/orgs/private-capital/resolutions/${resolutionId}/close`, { method: "PATCH", body: JSON.stringify({ orgId }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="mt-2 pt-2 border-t border-white/5 space-y-1.5">
      <form onSubmit={propose} className="flex gap-2">
        <input aria-label="Propose resolution" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Propose resolution" className="flex-1 bg-black/45 border border-white/15 rounded-lg px-2 py-1 text-[10px] text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <button disabled={!title.trim()} className="text-[10px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-2.5 py-1 rounded-lg disabled:opacity-40">Propose</button>
      </form>
      {error && <p className="text-red-400 text-[10px]">{error}</p>}
      {!resolutions || resolutions.length === 0 ? <Empty /> : resolutions.map((r) => (
        <div key={r.id} className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-[var(--inaya-text-muted)]">{r.title} <span className="font-mono">[{r.status === "PROPOSED" ? `${r.votes.length} votes` : r.outcome}]</span></span>
          {r.status === "PROPOSED" && (
            <div className="flex gap-1.5 shrink-0">
              <button onClick={() => vote(r.id, "approve")} className="text-[10px] font-bold uppercase text-emerald-400">Approve</button>
              <button onClick={() => vote(r.id, "reject")} className="text-[10px] font-bold uppercase text-red-400">Reject</button>
              <button onClick={() => close(r.id)} className="text-[10px] font-bold uppercase text-[#00f2fe]">Close voting</button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function ValueCreationSection({ orgId, portfolioCompanyId }) {
  const [plans, setPlans] = useState(null);
  const [category, setCategory] = useState("30_60_90_day");
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const CATEGORIES = ["30_60_90_day", "strategic_initiative", "hiring", "revenue", "cost", "product", "security", "compliance", "ma", "financing"];
  const STATUSES = ["not_started", "in_progress", "complete", "blocked"];

  const load = useCallback(async () => {
    try {
      setError("");
      setPlans((await api(`/api/orgs/private-capital/portfolio-companies/${portfolioCompanyId}/value-creation?orgId=${orgId}`)).plans);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId, portfolioCompanyId]);

  useEffect(() => { load(); }, [load]);

  async function create(e) {
    e.preventDefault();
    if (!title.trim()) return;
    try {
      setError("");
      await api(`/api/orgs/private-capital/portfolio-companies/${portfolioCompanyId}/value-creation`, { method: "POST", body: JSON.stringify({ orgId, category, title: title.trim() }) });
      setTitle("");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function setStatus(planId, status) {
    try {
      setError("");
      await api(`/api/orgs/private-capital/portfolio-companies/${portfolioCompanyId}/value-creation`, { method: "PATCH", body: JSON.stringify({ orgId, planId, status }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="space-y-2">
      <form onSubmit={create} className="flex flex-wrap gap-2">
        <select value={category} onChange={(e) => setCategory(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-2 py-1 text-[10px] text-[var(--inaya-text-primary)]">
          {CATEGORIES.map((c) => <option key={c} value={c}>{c.replace(/_/g, " ")}</option>)}
        </select>
        <input aria-label="Plan title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Plan title" className="flex-1 min-w-[140px] bg-black/45 border border-white/15 rounded-lg px-2 py-1 text-[10px] text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <button disabled={!title.trim()} className="text-[10px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-2.5 py-1 rounded-lg disabled:opacity-40">Add plan</button>
      </form>
      {error && <p className="text-red-400 text-[10px]">{error}</p>}
      {!plans || plans.length === 0 ? <Empty /> : plans.map((p) => (
        <div key={p.id} className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-[var(--inaya-text-muted)] truncate">{p.title} · {p.category.replace(/_/g, " ")}</span>
          <select value={p.status} onChange={(e) => setStatus(p.id, e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-1.5 py-0.5 text-[10px] text-[var(--inaya-text-primary)] shrink-0">
            {STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, " ")}</option>)}
          </select>
        </div>
      ))}
    </div>
  );
}

export function KpiSection({ orgId, portfolioCompanyId }) {
  const [kpis, setKpis] = useState(null);
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const [monitoring, setMonitoring] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setError("");
      const [kpiData, monitoringData] = await Promise.all([
        api(`/api/orgs/private-capital/portfolio-companies/${portfolioCompanyId}/kpis?orgId=${orgId}`),
        api(`/api/orgs/private-capital/portfolio-companies/${portfolioCompanyId}/monitoring?orgId=${orgId}`),
      ]);
      setKpis(kpiData.kpis);
      setMonitoring(monitoringData);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId, portfolioCompanyId]);

  useEffect(() => { load(); }, [load]);

  async function define(e) {
    e.preventDefault();
    if (!key.trim() || !label.trim()) return;
    try {
      setError("");
      await api(`/api/orgs/private-capital/portfolio-companies/${portfolioCompanyId}/kpis`, { method: "POST", body: JSON.stringify({ orgId, key: key.trim(), label: label.trim() }) });
      setKey(""); setLabel("");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function recordValue(kpiId, period, value) {
    try {
      setError("");
      await api(`/api/orgs/private-capital/kpis/${kpiId}/values`, { method: "POST", body: JSON.stringify({ orgId, period, value: parseFloat(value) }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="space-y-3">
      <form onSubmit={define} className="flex flex-wrap gap-2">
        <input aria-label="Key (e.g. arr)" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Key (e.g. arr)" className="w-28 bg-black/45 border border-white/15 rounded-lg px-2 py-1 text-[10px] text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input aria-label="Label (e.g. ARR)" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (e.g. ARR)" className="flex-1 min-w-[100px] bg-black/45 border border-white/15 rounded-lg px-2 py-1 text-[10px] text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <button disabled={!key.trim() || !label.trim()} className="text-[10px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-2.5 py-1 rounded-lg disabled:opacity-40">Define KPI</button>
      </form>
      {error && <p className="text-red-400 text-[10px]">{error}</p>}
      {!kpis || kpis.length === 0 ? <Empty /> : kpis.map((k) => <KpiRow key={k.id} kpi={k} onRecord={recordValue} />)}
      {monitoring && (
        <div className="pt-2 border-t border-white/5 text-[11px] text-[var(--inaya-text-muted)] space-y-1">
          <p>Upcoming board deadlines: {monitoring.upcomingBoardDeadlines.length}</p>
          <p>Open action items: {monitoring.openActionItems.length}</p>
          <p>Value-creation status: {Object.entries(monitoring.valueCreationPlanStatus).map(([s, n]) => `${s}: ${n}`).join(", ") || "none yet"}</p>
          <p className="text-amber-400">Not covered by monitoring yet: {monitoring.notCovered.join(", ")}</p>
        </div>
      )}
    </div>
  );
}

export function KpiRow({ kpi, onRecord }) {
  const [period, setPeriod] = useState("");
  const [value, setValue] = useState("");
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[11px] text-[var(--inaya-text-primary)] w-24 truncate">{kpi.label}</span>
      <span className="text-[10px] font-mono text-[var(--inaya-text-muted)]">{kpi.values.map((v) => `${v.period}:${v.value}`).join(" ") || "no data"}</span>
      <input aria-label="Period" value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="Period" className="w-20 bg-black/45 border border-white/15 rounded-lg px-1.5 py-0.5 text-[10px] text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
      <input aria-label="Value" value={value} onChange={(e) => setValue(e.target.value)} type="number" placeholder="Value" className="w-20 bg-black/45 border border-white/15 rounded-lg px-1.5 py-0.5 text-[10px] text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
      <button onClick={() => { onRecord(kpi.id, period, value); setPeriod(""); setValue(""); }} disabled={!period || !value} className="text-[10px] font-bold uppercase text-[#00f2fe] disabled:opacity-40">Record</button>
    </div>
  );
}

export function CapTableSection({ orgId, portfolioCompanyId }) {
  const [snapshots, setSnapshots] = useState(null);
  const [holderName, setHolderName] = useState("");
  const [shares, setShares] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setError("");
      setSnapshots((await api(`/api/orgs/private-capital/portfolio-companies/${portfolioCompanyId}/cap-table?orgId=${orgId}`)).snapshots);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId, portfolioCompanyId]);

  useEffect(() => { load(); }, [load]);

  async function record(e) {
    e.preventDefault();
    if (!holderName.trim() || !shares) return;
    try {
      setError("");
      await api(`/api/orgs/private-capital/portfolio-companies/${portfolioCompanyId}/cap-table`, { method: "POST", body: JSON.stringify({ orgId, rows: [{ holderName: holderName.trim(), instrumentType: "common", fullyDilutedShares: parseFloat(shares) }] }) });
      setHolderName(""); setShares("");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function approve(snapshotId) {
    try {
      setError("");
      await api(`/api/orgs/private-capital/cap-table/${snapshotId}/approve`, { method: "PATCH", body: JSON.stringify({ orgId }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="space-y-2">
      <form onSubmit={record} className="flex flex-wrap gap-2">
        <input aria-label="Holder name" value={holderName} onChange={(e) => setHolderName(e.target.value)} placeholder="Holder name" className="flex-1 min-w-[120px] bg-black/45 border border-white/15 rounded-lg px-2 py-1 text-[10px] text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input aria-label="Fully diluted shares" value={shares} onChange={(e) => setShares(e.target.value)} type="number" placeholder="Fully diluted shares" className="w-40 bg-black/45 border border-white/15 rounded-lg px-2 py-1 text-[10px] text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <button disabled={!holderName.trim() || !shares} className="text-[10px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-2.5 py-1 rounded-lg disabled:opacity-40">Record snapshot</button>
      </form>
      {error && <p className="text-red-400 text-[10px]">{error}</p>}
      {!snapshots || snapshots.length === 0 ? <Empty /> : snapshots.map((s) => (
        <div key={s.id} className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-[var(--inaya-text-muted)]">v{s.version} · {s.totalFullyDilutedShares} shares {s.approvedByEmail ? `· approved by ${s.approvedByEmail}` : "· unapproved"}</span>
          {!s.approvedByEmail && <button onClick={() => approve(s.id)} className="text-[10px] font-bold uppercase text-[#00f2fe] shrink-0">Approve</button>}
        </div>
      ))}
    </div>
  );
}
