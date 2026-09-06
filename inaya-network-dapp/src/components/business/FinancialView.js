"use client";

// src/components/business/FinancialView.js
//
// Financial Services & Regulated Enterprise SOW, Phase 1 (Financial
// Entity Core) — Funds (with a Fund Workspace: team + investors +
// capital accounts), Entities, and Counterparties. Shared by both the
// "financial" (hedge funds/asset managers) and "private_capital" (PE/VC)
// verticals — Phase 2 (Investment Management) and Phase 3 (Private
// Capital) will each add their own vertical-specific tabs here later.
// Same self-contained-view pattern as HealthView.js/RegulatedView.js.

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../EmptyState";

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

const FUND_STATUS_STYLES = {
  forming: "bg-white/5 text-[var(--inaya-text-muted)] border-white/10",
  active: "bg-emerald-400/10 text-emerald-400 border-emerald-400/30",
  closed: "bg-amber-400/10 text-amber-400 border-amber-400/30",
  wound_down: "bg-red-400/10 text-red-400 border-red-400/30",
};

export default function FinancialView({ orgId }) {
  const [tab, setTab] = useState("funds");
  return (
    <div className="space-y-5">
      <div className="flex bg-[var(--inaya-surface)] border border-white/5 rounded-xl p-1 w-fit flex-wrap">
        <button onClick={() => setTab("funds")} className={`px-4 py-2 text-xs font-bold uppercase rounded-lg ${tab === "funds" ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>Funds</button>
        <button onClick={() => setTab("entities")} className={`px-4 py-2 text-xs font-bold uppercase rounded-lg ${tab === "entities" ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>Entities</button>
        <button onClick={() => setTab("counterparties")} className={`px-4 py-2 text-xs font-bold uppercase rounded-lg ${tab === "counterparties" ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>Counterparties</button>
      </div>
      {tab === "funds" && <FundsTab orgId={orgId} />}
      {tab === "entities" && <EntitiesTab orgId={orgId} />}
      {tab === "counterparties" && <CounterpartiesTab orgId={orgId} />}
    </div>
  );
}

// ============================================================
// FUNDS + FUND WORKSPACE
// ============================================================
function FundsTab({ orgId }) {
  const [funds, setFunds] = useState(null);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [selected, setSelected] = useState(null);

  const load = useCallback(async () => {
    try {
      setFunds((await api(`/api/orgs/financial/funds?orgId=${orgId}`)).funds);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => setShowCreate(true)} className="ml-auto text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg">+ New fund</button>
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!funds ? (
          <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>
        ) : funds.length === 0 ? (
          <EmptyState compact icon="💼" description="No funds match, or you have no fund-team assignments yet." ctaLabel="Register a fund" onCta={() => setShowCreate(true)} />
        ) : (
          <div className="space-y-2">
            {funds.map((f) => (
              <button key={f.id} onClick={() => setSelected(f)} className="w-full flex items-center justify-between gap-3 bg-black/20 border border-white/5 rounded-lg p-3 text-left hover:bg-white/5">
                <div className="min-w-0">
                  <span className="text-[var(--inaya-text-primary)] text-sm">{f.shortName || f.legalName}</span>
                  <p className="text-[var(--inaya-text-muted)] text-[12px] font-mono mt-0.5 truncate">{f.fundType || "unclassified"}{f.jurisdiction ? ` · ${f.jurisdiction}` : ""} · {f.baseCurrency}</p>
                </div>
                <span className={`text-[11px] font-bold uppercase px-2 py-0.5 rounded-full border shrink-0 ${FUND_STATUS_STYLES[f.status] || FUND_STATUS_STYLES.forming}`}>{f.status}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {showCreate && <CreateFundModal orgId={orgId} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load(); }} />}
      {selected && <FundWorkspaceModal orgId={orgId} fundId={selected.id} onClose={() => setSelected(null)} onChanged={load} />}
    </div>
  );
}

function CreateFundModal({ orgId, onClose, onCreated }) {
  const [legalName, setLegalName] = useState("");
  const [shortName, setShortName] = useState("");
  const [fundType, setFundType] = useState("hedge_fund");
  const [jurisdiction, setJurisdiction] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const FUND_TYPES = ["hedge_fund", "long_short", "global_macro", "quantitative", "multi_strategy", "credit", "event_driven", "activist", "private_equity", "venture_capital", "private_credit", "fund_of_funds"];

  async function handleSubmit(e) {
    e.preventDefault();
    if (!legalName.trim()) return;
    setSubmitting(true);
    setError("");
    try {
      await api("/api/orgs/financial/funds", { method: "POST", body: JSON.stringify({ orgId, legalName: legalName.trim(), shortName: shortName.trim() || undefined, fundType, jurisdiction: jurisdiction.trim() || undefined }) });
      onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Register fund" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-3">
        <input value={legalName} onChange={(e) => setLegalName(e.target.value)} required placeholder="Legal name" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input value={shortName} onChange={(e) => setShortName(e.target.value)} placeholder="Short name (optional)" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <select value={fundType} onChange={(e) => setFundType(e.target.value)} className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
          {FUND_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}
        </select>
        <input value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value)} placeholder="Jurisdiction (optional)" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        {error && <p className="text-red-400 text-xs">{error}</p>}
        <button disabled={submitting || !legalName.trim()} className="w-full py-2.5 rounded-xl text-xs font-bold uppercase tracking-wide bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40">{submitting ? "Registering…" : "Register fund"}</button>
      </form>
    </Modal>
  );
}

function FundWorkspaceModal({ orgId, fundId, onClose, onChanged }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState("");
  const [section, setSection] = useState("overview");

  const load = useCallback(() => {
    api(`/api/orgs/financial/funds/${fundId}?orgId=${orgId}`).then(setDetail).catch((err) => setError(err.message));
  }, [orgId, fundId]);

  useEffect(() => { load(); }, [load]);

  if (error) return <Modal title="Fund" onClose={onClose}><p className="text-red-400 text-xs">{error}</p></Modal>;
  if (!detail) return <Modal title="Fund" onClose={onClose}><p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p></Modal>;

  const SECTIONS = ["overview", "team", "investors", "counterparties"];

  return (
    <Modal title={detail.fund.shortName || detail.fund.legalName} onClose={onClose} wide>
      <div className="flex gap-1 flex-wrap mb-3 border-b border-white/5 pb-2">
        {SECTIONS.map((s) => (
          <button key={s} onClick={() => setSection(s)} className={`text-[10px] font-bold uppercase px-2 py-1 rounded ${section === s ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)] hover:text-slate-200"}`}>{s}</button>
        ))}
      </div>

      {section === "overview" && (
        <div className="space-y-3 text-sm">
          <p className="text-[12px] font-mono text-[var(--inaya-text-muted)]">{detail.fund.fundType} · {detail.fund.structureType} · {detail.fund.jurisdiction || "no jurisdiction"} · {detail.fund.baseCurrency}</p>
          <p className="text-[12px] text-[var(--inaya-text-muted)]">Administrator: {detail.fund.administrator || "—"} · Custodian: {detail.fund.custodian || "—"} · Prime broker: {detail.fund.primeBroker || "—"}</p>
          <FundStatusControl orgId={orgId} fundId={fundId} status={detail.fund.status} onChanged={() => { load(); onChanged(); }} />
        </div>
      )}
      {section === "team" && <FundTeamSection orgId={orgId} fundId={fundId} team={detail.team} onChanged={load} />}
      {section === "investors" && <FundInvestorsSection orgId={orgId} fundId={fundId} />}
      {section === "counterparties" && <p className="text-[var(--inaya-text-muted)] text-xs">Counterparty assignments to this fund are managed from the Counterparties tab.</p>}
    </Modal>
  );
}

function FundStatusControl({ orgId, fundId, status, onChanged }) {
  const [error, setError] = useState("");
  const NEXT = { forming: "active", active: "closed", closed: "wound_down" };
  async function advance() {
    try {
      await api("/api/orgs/financial/funds", { method: "PATCH", body: JSON.stringify({ orgId, fundId, status: NEXT[status] }) });
      onChanged();
    } catch (err) {
      setError(err.message);
    }
  }
  return (
    <div>
      {error && <p className="text-red-400 text-xs mb-1">{error}</p>}
      {NEXT[status] && <button onClick={advance} className="text-[11px] font-bold uppercase px-3 py-1.5 rounded-md bg-white/5 border border-white/10 text-[var(--inaya-text-primary)] hover:bg-white/10">Advance to {NEXT[status]}</button>}
    </div>
  );
}

function FundTeamSection({ orgId, fundId, team, onChanged }) {
  const [memberEmail, setMemberEmail] = useState("");
  const [role, setRole] = useState("analyst");
  const [error, setError] = useState("");
  async function assign(e) {
    e.preventDefault();
    if (!memberEmail.trim()) return;
    try {
      await api(`/api/orgs/financial/funds/${fundId}/team`, { method: "POST", body: JSON.stringify({ orgId, memberEmail: memberEmail.trim(), role }) });
      setMemberEmail("");
      onChanged();
    } catch (err) {
      setError(err.message);
    }
  }
  return (
    <Section title={`Team (${team.length})`}>
      <form onSubmit={assign} className="flex flex-wrap gap-2 mb-2">
        <input value={memberEmail} onChange={(e) => setMemberEmail(e.target.value)} type="email" placeholder="Member email" className="flex-1 min-w-[140px] bg-black/45 border border-white/15 rounded-lg px-2.5 py-1.5 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <select value={role} onChange={(e) => setRole(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-2.5 py-1.5 text-xs text-[var(--inaya-text-primary)]">
          {["responsible_partner", "portfolio_manager", "analyst", "operations", "compliance"].map((r) => <option key={r} value={r}>{r.replace(/_/g, " ")}</option>)}
        </select>
        <button className="text-[11px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3 py-1.5 rounded-lg">Assign</button>
      </form>
      {error && <p className="text-red-400 text-[11px] mb-1">{error}</p>}
      {team.length === 0 ? <Empty /> : team.map((t, i) => <Row key={i} left={t.email} right={t.role.replace(/_/g, " ")} />)}
    </Section>
  );
}

function FundInvestorsSection({ orgId, fundId }) {
  const [investors, setInvestors] = useState(null);
  const [legalName, setLegalName] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setInvestors((await api(`/api/orgs/financial/investors?orgId=${orgId}&fundId=${fundId}`)).investors);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId, fundId]);

  useEffect(() => { load(); }, [load]);

  async function create(e) {
    e.preventDefault();
    if (!legalName.trim()) return;
    try {
      await api("/api/orgs/financial/investors", { method: "POST", body: JSON.stringify({ orgId, fundId, legalName: legalName.trim() }) });
      setLegalName("");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <Section title={`Investors (${investors?.length ?? "…"})`}>
      <form onSubmit={create} className="flex flex-wrap gap-2 mb-2">
        <input value={legalName} onChange={(e) => setLegalName(e.target.value)} placeholder="Investor legal name" className="flex-1 min-w-[140px] bg-black/45 border border-white/15 rounded-lg px-2.5 py-1.5 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <button className="text-[11px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3 py-1.5 rounded-lg">Add</button>
      </form>
      {error && <p className="text-red-400 text-[11px] mb-1">{error}</p>}
      {!investors || investors.length === 0 ? <Empty /> : investors.map((inv) => <InvestorRow key={inv.id} orgId={orgId} fundId={fundId} investor={inv} />)}
    </Section>
  );
}

function InvestorRow({ orgId, fundId, investor }) {
  const [showCapital, setShowCapital] = useState(false);
  const [amount, setAmount] = useState("");
  const [type, setType] = useState("commitment");
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState("");

  const loadSummary = useCallback(async () => {
    try {
      setSummary(await api(`/api/orgs/financial/investors/${investor.id}/capital-events?orgId=${orgId}&fundId=${fundId}`));
    } catch (err) {
      setError(err.message);
    }
  }, [orgId, fundId, investor.id]);

  useEffect(() => { if (showCapital) loadSummary(); }, [showCapital, loadSummary]);

  async function record(e) {
    e.preventDefault();
    const amt = parseFloat(amount);
    if (!amt) return;
    try {
      await api(`/api/orgs/financial/investors/${investor.id}/capital-events`, { method: "POST", body: JSON.stringify({ orgId, fundId, type, amount: amt }) });
      setAmount("");
      loadSummary();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="bg-black/20 border border-white/5 rounded-lg p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[var(--inaya-text-primary)] text-xs truncate">{investor.legalName}</span>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[10px] font-mono text-[var(--inaya-text-muted)]">{investor.onboardingStatus}</span>
          <button onClick={() => setShowCapital((v) => !v)} className="text-[10px] font-bold uppercase text-[#00f2fe]">Capital account</button>
        </div>
      </div>
      {showCapital && (
        <div className="mt-2 pt-2 border-t border-white/5">
          <form onSubmit={record} className="flex flex-wrap gap-2 mb-1.5">
            <select value={type} onChange={(e) => setType(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-2 py-1 text-[11px] text-[var(--inaya-text-primary)]">
              {["commitment", "contribution", "distribution"].map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <input value={amount} onChange={(e) => setAmount(e.target.value)} type="number" placeholder="Amount" className="w-24 bg-black/45 border border-white/15 rounded-lg px-2 py-1 text-[11px] text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
            <button className="text-[10px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-2.5 py-1 rounded-lg">Record</button>
          </form>
          {error && <p className="text-red-400 text-[10px]">{error}</p>}
          {summary && (
            <p className="text-[11px] font-mono text-[var(--inaya-text-muted)]">
              Committed ${summary.totals.commitment || 0} · Contributed ${summary.totals.contribution || 0} · Distributed ${summary.totals.distribution || 0}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================
// ENTITIES
// ============================================================
function EntitiesTab({ orgId }) {
  const [entities, setEntities] = useState(null);
  const [type, setType] = useState("management_company");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const ENTITY_TYPES = ["management_company", "adviser", "office", "team", "investment_committee", "risk_committee", "compliance_committee", "board", "external_administrator", "prime_broker", "custodian", "auditor", "legal_counsel", "fund_administrator", "valuation_agent", "data_provider", "technology_vendor"];

  const load = useCallback(async () => {
    try {
      setEntities((await api(`/api/orgs/financial/entities?orgId=${orgId}`)).entities);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  async function create(e) {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      await api("/api/orgs/financial/entities", { method: "POST", body: JSON.stringify({ orgId, type, name: name.trim() }) });
      setName("");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={create} className="flex flex-wrap gap-2">
        <select value={type} onChange={(e) => setType(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
          {ENTITY_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}
        </select>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Entity name" className="flex-1 min-w-[160px] bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <button disabled={!name.trim()} className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg disabled:opacity-40">Create</button>
      </form>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!entities ? <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p> : entities.length === 0 ? (
          <EmptyState compact icon="🏢" description="No entities yet." />
        ) : (
          <div className="space-y-2">{entities.map((e) => <Row key={e.id} left={e.name} right={e.type.replace(/_/g, " ")} />)}</div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// COUNTERPARTIES
// ============================================================
const NEXT_ONBOARDING_ACTION = { REQUESTED: "sendQuestionnaire", QUESTIONNAIRE: "submitForRiskAssessment", RISK_ASSESSMENT: "submitForLegalReview", LEGAL_REVIEW: "approve", APPROVED: "contract", CONTRACTED: "beginMonitoring" };
const NEXT_ONBOARDING_LABEL = { REQUESTED: "Send questionnaire", QUESTIONNAIRE: "Submit for risk assessment", RISK_ASSESSMENT: "Submit for legal review", LEGAL_REVIEW: "Approve", APPROVED: "Contract", CONTRACTED: "Begin monitoring" };

function CounterpartiesTab({ orgId }) {
  const [counterparties, setCounterparties] = useState(null);
  const [type, setType] = useState("prime_broker");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const TYPES = ["prime_broker", "bank", "custodian", "otc_counterparty", "clearing_broker", "administrator", "technology_vendor", "data_vendor", "legal_provider"];

  const load = useCallback(async () => {
    try {
      setCounterparties((await api(`/api/orgs/financial/counterparties?orgId=${orgId}`)).counterparties);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  async function create(e) {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      await api("/api/orgs/financial/counterparties", { method: "POST", body: JSON.stringify({ orgId, type, name: name.trim() }) });
      setName("");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function advance(counterpartyId, onboardingStatus) {
    const action = NEXT_ONBOARDING_ACTION[onboardingStatus];
    if (!action) return;
    try {
      await api(`/api/orgs/financial/counterparties/${counterpartyId}/transition`, { method: "PATCH", body: JSON.stringify({ orgId, action }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={create} className="flex flex-wrap gap-2">
        <select value={type} onChange={(e) => setType(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
          {TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}
        </select>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Counterparty name" className="flex-1 min-w-[160px] bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <button disabled={!name.trim()} className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg disabled:opacity-40">Add</button>
      </form>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!counterparties ? <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p> : counterparties.length === 0 ? (
          <EmptyState compact icon="🤝" description="No counterparties yet." />
        ) : (
          <div className="space-y-2">
            {counterparties.map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-3 bg-black/20 border border-white/5 rounded-lg p-3">
                <div className="min-w-0">
                  <span className="text-[var(--inaya-text-primary)] text-sm">{c.name}</span>
                  <p className="text-[var(--inaya-text-muted)] text-[12px] font-mono mt-0.5">{c.type.replace(/_/g, " ")} · risk: {c.riskRating}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[11px] font-bold uppercase px-2 py-0.5 rounded-full border border-white/10 text-[var(--inaya-text-muted)]">{c.onboardingStatus.replace(/_/g, " ")}</span>
                  {NEXT_ONBOARDING_ACTION[c.onboardingStatus] && <button onClick={() => advance(c.id, c.onboardingStatus)} className="text-[10px] font-bold uppercase text-[#00f2fe] whitespace-nowrap">{NEXT_ONBOARDING_LABEL[c.onboardingStatus]}</button>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// SHARED PRIMITIVES
// ============================================================
function Section({ title, children }) {
  return (
    <div>
      <p className="text-[11px] font-bold uppercase tracking-wide text-[var(--inaya-text-muted)] mb-1.5">{title}</p>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function Row({ left, right }) {
  return (
    <div className="flex items-center justify-between bg-black/20 border border-white/5 rounded-lg px-3 py-1.5">
      <span className="text-[var(--inaya-text-primary)] text-xs truncate">{left}</span>
      <span className="text-[var(--inaya-text-muted)] text-[11px] font-mono shrink-0 ml-2">{right}</span>
    </div>
  );
}

function Empty() {
  return <p className="text-[var(--inaya-text-muted)] text-[11px] font-mono">None.</p>;
}

function Modal({ title, onClose, children, wide }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className={`bg-[var(--inaya-surface)] border border-white/10 rounded-2xl p-5 w-full ${wide ? "max-w-2xl" : "max-w-md"} max-h-[85vh] overflow-y-auto`}>
        <div className="flex items-center justify-between gap-3 mb-4">
          <h3 className="text-[var(--inaya-text-primary)] font-bold text-sm truncate">{title}</h3>
          <button onClick={onClose} className="text-[var(--inaya-text-muted)] hover:text-[var(--inaya-text-primary)] text-lg leading-none shrink-0">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
