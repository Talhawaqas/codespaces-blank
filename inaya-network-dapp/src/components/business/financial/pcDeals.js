"use client";

// src/components/business/financial/pcDeals.js — PRIVATE CAPITAL: DEALS (Phase 3, §29-33 — pipeline, screening, diligence, term sheets, all fund-scoped like everything else here)
// Moved verbatim from FinancialView.js (Business Workspace gap closure, Batch 3).

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../../EmptyState";
import { Empty, Row, api } from "./shared.js";

// ============================================================
// PRIVATE CAPITAL: DEALS (Phase 3, §29-33 — pipeline, screening,
// diligence, term sheets, all fund-scoped like everything else here)
// ============================================================
export const DEAL_NEXT_ACTION = { SOURCED: "advance", SCREENED: "advance", INITIAL_REVIEW: "advance", PARTNER_REVIEW: "advance", DILIGENCE: "advance", IC: "advance", TERM_SHEET: "advance", NEGOTIATION: "advance" };
export const DILIGENCE_DOMAINS = ["commercial", "financial", "legal", "tax", "technology", "cybersecurity", "product", "market", "regulatory", "hr", "ip", "insurance", "esg", "data_protection", "vendor_risk", "operations"];
export const SCORECARD_CRITERIA = ["market", "team", "product", "traction", "financials", "moat", "competition", "regulatory_risk", "technical_risk", "cybersecurity", "customer_concentration", "capital_efficiency", "valuation", "exit_potential", "strategic_fit"];

export function DealsTab({ orgId }) {
  const [funds, setFunds] = useState(null);
  const [fundId, setFundId] = useState("");
  const [deals, setDeals] = useState(null);
  const [company, setCompany] = useState("");
  const [expanded, setExpanded] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api(`/api/orgs/financial/funds?orgId=${orgId}`).then((d) => { setFunds(d.funds); if (d.funds.length > 0) setFundId((cur) => cur || d.funds[0].id); }).catch(() => setFunds([]));
  }, [orgId]);

  const load = useCallback(async () => {
    if (!fundId) return;
    try {
      setError("");
      setDeals((await api(`/api/orgs/private-capital/deals?orgId=${orgId}&fundId=${fundId}`)).deals);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId, fundId]);

  useEffect(() => { load(); }, [load]);

  async function create(e) {
    e.preventDefault();
    if (!company.trim() || !fundId) return;
    try {
      setError("");
      await api("/api/orgs/private-capital/deals", { method: "POST", body: JSON.stringify({ orgId, fundId, company: company.trim() }) });
      setCompany("");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function act(dealId, action) {
    try {
      setError("");
      await api("/api/orgs/private-capital/deals", { method: "PATCH", body: JSON.stringify({ orgId, dealId, action }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function convert(dealId) {
    try {
      setError("");
      await api(`/api/orgs/private-capital/deals/${dealId}/convert-to-portfolio`, { method: "POST", body: JSON.stringify({ orgId }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  if (!funds) return <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>;
  if (funds.length === 0) return <EmptyState compact icon="🤝" description="Register a fund first (Funds tab) before tracking deals." />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <select value={fundId} onChange={(e) => setFundId(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
          {funds.map((f) => <option key={f.id} value={f.id}>{f.shortName || f.legalName}</option>)}
        </select>
        <input aria-label="New deal: target company" value={company} onChange={(e) => setCompany(e.target.value)} placeholder="New deal: target company" className="flex-1 min-w-[160px] bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <button onClick={create} disabled={!company.trim()} className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg disabled:opacity-40">New deal</button>
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!deals ? <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p> : deals.length === 0 ? (
          <EmptyState compact icon="🤝" description="No deals in the pipeline for this fund yet." />
        ) : (
          <div className="space-y-2">
            {deals.map((d) => (
              <div key={d.id} className="bg-black/20 border border-white/5 rounded-lg p-3">
                <button onClick={() => setExpanded(expanded === d.id ? null : d.id)} className="w-full flex items-center justify-between gap-3 text-left">
                  <span className="text-[var(--inaya-text-primary)] text-sm truncate">{d.company}</span>
                  <span className="text-[11px] font-bold uppercase px-2 py-0.5 rounded-full border border-white/10 text-[var(--inaya-text-muted)] shrink-0">{d.stage.replace(/_/g, " ")}</span>
                </button>
                <div className="flex flex-wrap gap-2 mt-2">
                  {DEAL_NEXT_ACTION[d.stage] && <button onClick={() => act(d.id, "advance")} className="text-[10px] font-bold uppercase text-[#00f2fe]">Advance</button>}
                  {d.stage !== "PORTFOLIO" && d.stage !== "PASSED" && <button onClick={() => act(d.id, "pass")} className="text-[10px] font-bold uppercase text-[var(--inaya-text-muted)] hover:text-red-400">Pass</button>}
                  {d.stage === "PASSED" && <button onClick={() => act(d.id, "reopen")} className="text-[10px] font-bold uppercase text-[#00f2fe]">Reopen</button>}
                  {d.stage === "CLOSING" && <button onClick={() => convert(d.id)} className="text-[10px] font-bold uppercase text-emerald-400">Convert to portfolio</button>}
                </div>
                {expanded === d.id && <DealDetail orgId={orgId} deal={d} />}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function DealDetail({ orgId, deal }) {
  const [section, setSection] = useState("scorecards");
  return (
    <div className="mt-2 pt-2 border-t border-white/5">
      <div className="flex gap-1 flex-wrap mb-2">
        {["scorecards", "diligence", "term sheets"].map((s) => (
          <button key={s} onClick={() => setSection(s)} className={`text-[10px] font-bold uppercase px-2 py-1 rounded ${section === s ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>{s}</button>
        ))}
      </div>
      {section === "scorecards" && <DealScorecards orgId={orgId} dealId={deal.id} />}
      {section === "diligence" && <DealDiligence orgId={orgId} dealId={deal.id} />}
      {section === "term sheets" && <DealTermSheets orgId={orgId} dealId={deal.id} />}
    </div>
  );
}

export function DealScorecards({ orgId, dealId }) {
  const [scorecards, setScorecards] = useState(null);
  const [criterion, setCriterion] = useState("team");
  const [score, setScore] = useState("");
  const [rationale, setRationale] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setError("");
      setScorecards((await api(`/api/orgs/private-capital/deals/${dealId}/scorecards?orgId=${orgId}`)).scorecards);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId, dealId]);

  useEffect(() => { load(); }, [load]);

  async function submit(e) {
    e.preventDefault();
    if (!score) return;
    try {
      setError("");
      await api(`/api/orgs/private-capital/deals/${dealId}/scorecards`, { method: "POST", body: JSON.stringify({ orgId, scores: { [criterion]: { score: parseFloat(score), weight: 1 } }, rationale: rationale.trim() || undefined }) });
      setScore(""); setRationale("");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="space-y-2">
      <form onSubmit={submit} className="flex flex-wrap gap-2">
        <select value={criterion} onChange={(e) => setCriterion(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-2 py-1 text-[10px] text-[var(--inaya-text-primary)]">
          {SCORECARD_CRITERIA.map((c) => <option key={c} value={c}>{c.replace(/_/g, " ")}</option>)}
        </select>
        <input aria-label="Score 0-10" value={score} onChange={(e) => setScore(e.target.value)} type="number" min="0" max="10" placeholder="Score 0-10" className="w-24 bg-black/45 border border-white/15 rounded-lg px-2 py-1 text-[10px] text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input aria-label="Rationale" value={rationale} onChange={(e) => setRationale(e.target.value)} placeholder="Rationale" className="flex-1 min-w-[120px] bg-black/45 border border-white/15 rounded-lg px-2 py-1 text-[10px] text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <button disabled={!score} className="text-[10px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-2.5 py-1 rounded-lg disabled:opacity-40">Submit score</button>
      </form>
      {error && <p className="text-red-400 text-[10px]">{error}</p>}
      {!scorecards || scorecards.length === 0 ? <Empty /> : scorecards.map((s) => (
        <Row key={s.id} left={`v${s.version} · ${s.evaluatorEmail}${s.rationale ? ` — ${s.rationale}` : ""}`} right={s.weightedScore != null ? s.weightedScore.toFixed(1) : "—"} />
      ))}
    </div>
  );
}

export function DealDiligence({ orgId, dealId }) {
  const [requests, setRequests] = useState(null);
  const [domain, setDomain] = useState("commercial");
  const [request, setRequest] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setError("");
      setRequests((await api(`/api/orgs/private-capital/deals/${dealId}/diligence?orgId=${orgId}`)).requests);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId, dealId]);

  useEffect(() => { load(); }, [load]);

  async function create(e) {
    e.preventDefault();
    if (!request.trim()) return;
    try {
      setError("");
      await api(`/api/orgs/private-capital/deals/${dealId}/diligence`, { method: "POST", body: JSON.stringify({ orgId, domain, request: request.trim() }) });
      setRequest("");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function advance(requestId, action) {
    try {
      setError("");
      await api(`/api/orgs/private-capital/diligence/${requestId}`, { method: "PATCH", body: JSON.stringify({ orgId, action }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function review(requestId) {
    try {
      setError("");
      await api(`/api/orgs/private-capital/diligence/${requestId}/review`, { method: "PATCH", body: JSON.stringify({ orgId, conclusion: "No material issues found." }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  const NEXT = { OPEN: "start", IN_PROGRESS: "submit" };

  return (
    <div className="space-y-2">
      <form onSubmit={create} className="flex flex-wrap gap-2">
        <select value={domain} onChange={(e) => setDomain(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-2 py-1 text-[10px] text-[var(--inaya-text-primary)]">
          {DILIGENCE_DOMAINS.map((d) => <option key={d} value={d}>{d.replace(/_/g, " ")}</option>)}
        </select>
        <input aria-label="Request (e.g. audited financials)" value={request} onChange={(e) => setRequest(e.target.value)} placeholder="Request (e.g. audited financials)" className="flex-1 min-w-[140px] bg-black/45 border border-white/15 rounded-lg px-2 py-1 text-[10px] text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <button disabled={!request.trim()} className="text-[10px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-2.5 py-1 rounded-lg disabled:opacity-40">Add request</button>
      </form>
      {error && <p className="text-red-400 text-[10px]">{error}</p>}
      {!requests || requests.length === 0 ? <Empty /> : requests.map((r) => (
        <div key={r.id} className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-[var(--inaya-text-muted)] truncate">{r.domain.replace(/_/g, " ")}: {r.request} <span className="font-mono">[{r.status}]</span></span>
          <div className="flex gap-1.5 shrink-0">
            {NEXT[r.status] && <button onClick={() => advance(r.id, NEXT[r.status])} className="text-[10px] font-bold uppercase text-[#00f2fe]">{NEXT[r.status]}</button>}
            {r.status === "SUBMITTED" && <button onClick={() => review(r.id)} className="text-[10px] font-bold uppercase text-[#00f2fe]">Review</button>}
            {r.status === "REVIEWED" && <button onClick={() => advance(r.id, "close")} className="text-[10px] font-bold uppercase text-[#00f2fe]">Close</button>}
          </div>
        </div>
      ))}
    </div>
  );
}

export function DealTermSheets({ orgId, dealId }) {
  const [termSheets, setTermSheets] = useState(null);
  const [valuation, setValuation] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setError("");
      setTermSheets((await api(`/api/orgs/private-capital/deals/${dealId}/term-sheets?orgId=${orgId}`)).termSheets);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId, dealId]);

  useEffect(() => { load(); }, [load]);

  async function create(e) {
    e.preventDefault();
    if (!valuation) return;
    try {
      setError("");
      await api(`/api/orgs/private-capital/deals/${dealId}/term-sheets`, { method: "POST", body: JSON.stringify({ orgId, valuation: parseFloat(valuation) }) });
      setValuation("");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function transition(termSheetId, action) {
    try {
      setError("");
      await api(`/api/orgs/private-capital/term-sheets/${termSheetId}/transition`, { method: "PATCH", body: JSON.stringify({ orgId, action }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function revise(termSheetId) {
    try {
      setError("");
      await api(`/api/orgs/private-capital/term-sheets/${termSheetId}/revise`, { method: "POST", body: JSON.stringify({ orgId, updates: {} }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  const NEXT = { DRAFT: "send", SENT: "counter" };

  return (
    <div className="space-y-2">
      <form onSubmit={create} className="flex flex-wrap gap-2">
        <input aria-label="New round: valuation" value={valuation} onChange={(e) => setValuation(e.target.value)} type="number" placeholder="New round: valuation" className="flex-1 min-w-[140px] bg-black/45 border border-white/15 rounded-lg px-2 py-1 text-[10px] text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <button disabled={!valuation} className="text-[10px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-2.5 py-1 rounded-lg disabled:opacity-40">Draft term sheet</button>
      </form>
      {error && <p className="text-red-400 text-[10px]">{error}</p>}
      {!termSheets || termSheets.length === 0 ? <Empty /> : termSheets.map((t) => (
        <div key={t.id} className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-[var(--inaya-text-muted)]">v{t.version} · ${t.valuation} <span className="font-mono">[{t.status}]</span></span>
          <div className="flex gap-1.5 shrink-0">
            {NEXT[t.status] && <button onClick={() => transition(t.id, NEXT[t.status])} className="text-[10px] font-bold uppercase text-[#00f2fe]">{NEXT[t.status]}</button>}
            {["SENT", "COUNTERED"].includes(t.status) && <button onClick={() => transition(t.id, "accept")} className="text-[10px] font-bold uppercase text-emerald-400">Accept</button>}
            {["SENT", "COUNTERED"].includes(t.status) && <button onClick={() => revise(t.id)} className="text-[10px] font-bold uppercase text-[var(--inaya-text-muted)]">Revise</button>}
          </div>
        </div>
      ))}
    </div>
  );
}
