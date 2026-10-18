"use client";

// src/components/business/financial/committee.js — INVESTMENT COMMITTEE (Phase 2, §8)
// Moved verbatim from FinancialView.js (Business Workspace gap closure, Batch 3).

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../../EmptyState";
import { Empty, Row, Section, api } from "./shared.js";

// ============================================================
// INVESTMENT COMMITTEE (Phase 2, §8)
// ============================================================
export const IC_NEXT_ACTION = { DRAFT: "submit", SUBMITTED: "startResearch", UNDER_RESEARCH: "submitForComplianceReview", COMPLIANCE_REVIEW: "submitForRiskReview", RISK_REVIEW: "scheduleIC", DEFERRED: "resumeFromDeferral" };
export const IC_NEXT_LABEL = { DRAFT: "Submit", SUBMITTED: "Start research", UNDER_RESEARCH: "Send to compliance review", COMPLIANCE_REVIEW: "Send to risk review", RISK_REVIEW: "Schedule IC", DEFERRED: "Resume" };
export const IC_WITHDRAWABLE = ["DRAFT", "SUBMITTED", "UNDER_RESEARCH", "COMPLIANCE_REVIEW", "RISK_REVIEW", "IC_SCHEDULED"];

export function CommitteeTab({ orgId }) {
  const [cases, setCases] = useState(null);
  const [opportunity, setOpportunity] = useState("");
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(null);

  const load = useCallback(async () => {
    try {
      setError("");
      setCases((await api(`/api/orgs/financial/ic-cases?orgId=${orgId}`)).cases);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  async function create(e) {
    e.preventDefault();
    if (!opportunity.trim()) return;
    try {
      setError("");
      await api("/api/orgs/financial/ic-cases", { method: "POST", body: JSON.stringify({ orgId, opportunity: opportunity.trim() }) });
      setOpportunity("");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function act(caseId, action) {
    try {
      setError("");
      await api("/api/orgs/financial/ic-cases", { method: "PATCH", body: JSON.stringify({ orgId, caseId, action }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={create} className="flex flex-wrap gap-2">
        <input aria-label="Opportunity description" value={opportunity} onChange={(e) => setOpportunity(e.target.value)} placeholder="Opportunity description" className="flex-1 min-w-[200px] bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <button disabled={!opportunity.trim()} className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg disabled:opacity-40">New case</button>
      </form>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!cases ? <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p> : cases.length === 0 ? (
          <EmptyState compact icon="🗳️" description="No IC cases yet." />
        ) : (
          <div className="space-y-2">
            {cases.map((c) => (
              <div key={c.id} className="bg-black/20 border border-white/5 rounded-lg p-3">
                <button onClick={() => setExpanded(expanded === c.id ? null : c.id)} className="w-full flex items-center justify-between gap-3 text-left">
                  <span className="text-[var(--inaya-text-primary)] text-sm truncate">{c.opportunity}</span>
                  <span className="text-[11px] font-bold uppercase px-2 py-0.5 rounded-full border border-white/10 text-[var(--inaya-text-muted)] shrink-0">{c.status.replace(/_/g, " ")}</span>
                </button>
                <div className="flex flex-wrap gap-2 mt-2">
                  {IC_NEXT_ACTION[c.status] && <button onClick={() => act(c.id, IC_NEXT_ACTION[c.status])} className="text-[10px] font-bold uppercase text-[#00f2fe]">{IC_NEXT_LABEL[c.status]}</button>}
                  {IC_WITHDRAWABLE.includes(c.status) && <button onClick={() => act(c.id, "withdraw")} className="text-[10px] font-bold uppercase text-[var(--inaya-text-muted)] hover:text-red-400">Withdraw</button>}
                  {["APPROVED", "APPROVED_WITH_CONDITIONS"].includes(c.status) && <button onClick={() => act(c.id, "execute")} className="text-[10px] font-bold uppercase text-[#00f2fe]">Execute</button>}
                  {c.status === "EXECUTED" && <button onClick={() => act(c.id, "beginMonitoring")} className="text-[10px] font-bold uppercase text-[#00f2fe]">Begin monitoring</button>}
                  {c.status === "MONITORING" && <button onClick={() => act(c.id, "close")} className="text-[10px] font-bold uppercase text-[#00f2fe]">Close</button>}
                </div>
                {expanded === c.id && <ICCaseDecisionPanel orgId={orgId} icCase={c} onChanged={load} />}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function ICCaseDecisionPanel({ orgId, icCase, onChanged }) {
  const [history, setHistory] = useState(null);
  const [outcome, setOutcome] = useState("approve");
  const [finalResolution, setFinalResolution] = useState("");
  const [amending, setAmending] = useState(false);
  const [amendText, setAmendText] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setError("");
      setHistory((await api(`/api/orgs/financial/ic-cases/${icCase.id}/decision?orgId=${orgId}`)).decisions);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId, icCase.id]);

  useEffect(() => { load(); }, [load]);

  async function record(e) {
    e.preventDefault();
    try {
      setError("");
      await api(`/api/orgs/financial/ic-cases/${icCase.id}/decision`, { method: "POST", body: JSON.stringify({ orgId, outcome, finalResolution: finalResolution.trim() || undefined }) });
      setFinalResolution("");
      load();
      onChanged();
    } catch (err) {
      setError(err.message);
    }
  }

  async function amend(e) {
    e.preventDefault();
    try {
      setError("");
      await api(`/api/orgs/financial/ic-cases/${icCase.id}/decision`, { method: "PATCH", body: JSON.stringify({ orgId, finalResolution: amendText }) });
      setAmending(false);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="mt-2 pt-2 border-t border-white/5 space-y-2">
      {error && <p className="text-red-400 text-[10px]">{error}</p>}
      {icCase.status === "IC_SCHEDULED" && (
        <form onSubmit={record} className="flex flex-wrap gap-2">
          <select value={outcome} onChange={(e) => setOutcome(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-2 py-1.5 text-[11px] text-[var(--inaya-text-primary)]">
            {["approve", "approveWithConditions", "reject", "defer"].map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
          <input aria-label="Final resolution" value={finalResolution} onChange={(e) => setFinalResolution(e.target.value)} placeholder="Final resolution" className="flex-1 min-w-[140px] bg-black/45 border border-white/15 rounded-lg px-2.5 py-1.5 text-[11px] text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
          <button className="text-[10px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-2.5 py-1 rounded-lg">Record decision</button>
        </form>
      )}
      <Section title={`Decision history (${history?.length ?? "…"})`}>
        {!history || history.length === 0 ? <Empty /> : history.map((d) => (
          <Row key={d.id} left={`v${d.version} · ${d.outcome.replace(/_/g, " ")}${d.finalResolution ? ` — ${d.finalResolution}` : ""}`} right={d.decidedByEmail} />
        ))}
      </Section>
      {history && history.length > 0 && !amending && (
        <button onClick={() => { setAmendText(history[0]?.finalResolution || ""); setAmending(true); }} className="text-[10px] font-bold uppercase text-[var(--inaya-text-muted)] hover:text-slate-200">Amend latest decision (creates v{(history[0]?.version || 1) + 1})</button>
      )}
      {amending && (
        <form onSubmit={amend} className="flex gap-2">
          <input aria-label="Amended final resolution" value={amendText} onChange={(e) => setAmendText(e.target.value)} placeholder="Amended final resolution" className="flex-1 bg-black/45 border border-white/15 rounded-lg px-2.5 py-1.5 text-[11px] text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
          <button className="text-[10px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-2.5 py-1 rounded-lg">Save v{(history[0]?.version || 1) + 1}</button>
          <button type="button" onClick={() => setAmending(false)} className="text-[10px] font-bold uppercase text-[var(--inaya-text-muted)]">Cancel</button>
        </form>
      )}
    </div>
  );
}
