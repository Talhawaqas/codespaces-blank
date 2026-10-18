"use client";

// src/components/business/financial/research.js — RESEARCH (Phase 2, §7 provenance repository)
// Moved verbatim from FinancialView.js (Business Workspace gap closure, Batch 3).

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../../EmptyState";
import { Empty, api } from "./shared.js";

// ============================================================
// RESEARCH (Phase 2, §7 provenance repository)
// ============================================================
export const RESEARCH_TYPES = ["analyst_report", "broker_research", "public_filing", "earnings_material", "investor_presentation", "management_interview", "expert_call", "industry_report", "alternative_data", "market_data_export", "financial_model", "valuation_model", "internal_note", "investment_thesis_note", "watchlist", "research_memo"];

export function ResearchTab({ orgId }) {
  const [research, setResearch] = useState(null);
  const [type, setType] = useState("analyst_report");
  const [company, setCompany] = useState("");
  const [source, setSource] = useState("");
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(null);

  const load = useCallback(async () => {
    try {
      setError("");
      setResearch((await api(`/api/orgs/financial/research?orgId=${orgId}`)).research);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  async function create(e) {
    e.preventDefault();
    if (!company.trim()) return;
    try {
      setError("");
      await api("/api/orgs/financial/research", { method: "POST", body: JSON.stringify({ orgId, type, company: company.trim(), source: source.trim() || undefined }) });
      setCompany(""); setSource("");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={create} className="flex flex-wrap gap-2">
        <select value={type} onChange={(e) => setType(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
          {RESEARCH_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}
        </select>
        <input aria-label="Company / target" value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Company / target" className="flex-1 min-w-[140px] bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input aria-label="Source (optional)" value={source} onChange={(e) => setSource(e.target.value)} placeholder="Source (optional)" className="flex-1 min-w-[140px] bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <button disabled={!company.trim()} className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg disabled:opacity-40">Add</button>
      </form>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!research ? <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p> : research.length === 0 ? (
          <EmptyState compact icon="🔎" description="No research records yet." />
        ) : (
          <div className="space-y-2">
            {research.map((r) => (
              <div key={r.id} className="bg-black/20 border border-white/5 rounded-lg p-3">
                <button onClick={() => setExpanded(expanded === r.id ? null : r.id)} className="w-full flex items-center justify-between gap-3 text-left">
                  <div className="min-w-0">
                    <span className="text-[var(--inaya-text-primary)] text-sm">{r.company || "(no company)"}</span>
                    <p className="text-[var(--inaya-text-muted)] text-[12px] font-mono mt-0.5 truncate">{r.type.replace(/_/g, " ")}{r.source ? ` · ${r.source}` : ""}</p>
                  </div>
                  <span className="text-[10px] font-mono text-[var(--inaya-text-muted)] shrink-0">{r.annotations?.length || 0} notes</span>
                </button>
                {expanded === r.id && <ResearchAnnotations orgId={orgId} research={r} onChanged={load} />}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function ResearchAnnotations({ orgId, research, onChanged }) {
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  async function submit(e) {
    e.preventDefault();
    if (!note.trim()) return;
    try {
      setError("");
      await api(`/api/orgs/financial/research/${research.id}/annotations`, { method: "POST", body: JSON.stringify({ orgId, note: note.trim() }) });
      setNote("");
      onChanged();
    } catch (err) {
      setError(err.message);
    }
  }
  return (
    <div className="mt-2 pt-2 border-t border-white/5 space-y-1.5">
      {(research.annotations || []).length === 0 ? <Empty /> : research.annotations.map((a, i) => (
        <p key={i} className="text-[11px] text-[var(--inaya-text-muted)]"><span className="font-mono">{a.actorEmail}:</span> {a.note}</p>
      ))}
      <form onSubmit={submit} className="flex gap-2 pt-1">
        <input aria-label="Add annotation (append-only)" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add annotation (append-only)" className="flex-1 bg-black/45 border border-white/15 rounded-lg px-2.5 py-1.5 text-[11px] text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <button className="text-[10px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-2.5 py-1 rounded-lg">Add</button>
      </form>
      {error && <p className="text-red-400 text-[10px]">{error}</p>}
    </div>
  );
}
