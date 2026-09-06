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

// Financial Services & Regulated Enterprise SOW, Phase 2 (Investment
// Management) — Research/Theses/Committee/Portfolio tabs are specific to
// running a fund's book, not to private-capital deal work, so they only
// render for the "financial" vertical, never "private_capital".
export default function FinancialView({ orgId, vertical }) {
  const [tab, setTab] = useState("funds");
  const isFinancial = vertical === "financial";
  const isPrivateCapital = vertical === "private_capital";
  return (
    <div className="space-y-5">
      <div className="flex bg-[var(--inaya-surface)] border border-white/5 rounded-xl p-1 w-fit flex-wrap">
        <button onClick={() => setTab("funds")} className={`px-4 py-2 text-xs font-bold uppercase rounded-lg ${tab === "funds" ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>Funds</button>
        <button onClick={() => setTab("entities")} className={`px-4 py-2 text-xs font-bold uppercase rounded-lg ${tab === "entities" ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>Entities</button>
        <button onClick={() => setTab("counterparties")} className={`px-4 py-2 text-xs font-bold uppercase rounded-lg ${tab === "counterparties" ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>Counterparties</button>
        {isFinancial && <button onClick={() => setTab("research")} className={`px-4 py-2 text-xs font-bold uppercase rounded-lg ${tab === "research" ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>Research</button>}
        {isFinancial && <button onClick={() => setTab("theses")} className={`px-4 py-2 text-xs font-bold uppercase rounded-lg ${tab === "theses" ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>Theses</button>}
        {(isFinancial || isPrivateCapital) && <button onClick={() => setTab("committee")} className={`px-4 py-2 text-xs font-bold uppercase rounded-lg ${tab === "committee" ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>Committee</button>}
        {isFinancial && <button onClick={() => setTab("portfolio")} className={`px-4 py-2 text-xs font-bold uppercase rounded-lg ${tab === "portfolio" ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>Portfolio</button>}
        {isPrivateCapital && <button onClick={() => setTab("deals")} className={`px-4 py-2 text-xs font-bold uppercase rounded-lg ${tab === "deals" ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>Deals</button>}
        {isPrivateCapital && <button onClick={() => setTab("pcPortfolio")} className={`px-4 py-2 text-xs font-bold uppercase rounded-lg ${tab === "pcPortfolio" ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>Portfolio</button>}
        {isPrivateCapital && <button onClick={() => setTab("fundraising")} className={`px-4 py-2 text-xs font-bold uppercase rounded-lg ${tab === "fundraising" ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>Fundraising</button>}
        {isPrivateCapital && <button onClick={() => setTab("exits")} className={`px-4 py-2 text-xs font-bold uppercase rounded-lg ${tab === "exits" ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>Exits</button>}
        {isPrivateCapital && <button onClick={() => setTab("spvs")} className={`px-4 py-2 text-xs font-bold uppercase rounded-lg ${tab === "spvs" ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>SPVs</button>}
      </div>
      {tab === "funds" && <FundsTab orgId={orgId} />}
      {tab === "entities" && <EntitiesTab orgId={orgId} />}
      {tab === "counterparties" && <CounterpartiesTab orgId={orgId} />}
      {isFinancial && tab === "research" && <ResearchTab orgId={orgId} />}
      {isFinancial && tab === "theses" && <ThesesTab orgId={orgId} />}
      {(isFinancial || isPrivateCapital) && tab === "committee" && <CommitteeTab orgId={orgId} />}
      {isFinancial && tab === "portfolio" && <PortfolioTab orgId={orgId} />}
      {isPrivateCapital && tab === "deals" && <DealsTab orgId={orgId} />}
      {isPrivateCapital && tab === "pcPortfolio" && <PrivateCapitalPortfolioTab orgId={orgId} />}
      {isPrivateCapital && tab === "fundraising" && <FundraisingTab orgId={orgId} />}
      {isPrivateCapital && tab === "exits" && <ExitsTab orgId={orgId} />}
      {isPrivateCapital && tab === "spvs" && <SpvsTab orgId={orgId} />}
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
// RESEARCH (Phase 2, §7 provenance repository)
// ============================================================
const RESEARCH_TYPES = ["analyst_report", "broker_research", "public_filing", "earnings_material", "investor_presentation", "management_interview", "expert_call", "industry_report", "alternative_data", "market_data_export", "financial_model", "valuation_model", "internal_note", "investment_thesis_note", "watchlist", "research_memo"];

function ResearchTab({ orgId }) {
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
        <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Company / target" className="flex-1 min-w-[140px] bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input value={source} onChange={(e) => setSource(e.target.value)} placeholder="Source (optional)" className="flex-1 min-w-[140px] bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
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

function ResearchAnnotations({ orgId, research, onChanged }) {
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
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add annotation (append-only)" className="flex-1 bg-black/45 border border-white/15 rounded-lg px-2.5 py-1.5 text-[11px] text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <button className="text-[10px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-2.5 py-1 rounded-lg">Add</button>
      </form>
      {error && <p className="text-red-400 text-[10px]">{error}</p>}
    </div>
  );
}

// ============================================================
// INVESTMENT THESES (Phase 2, §7 — versioned, never overwritten)
// ============================================================
const THESIS_NEXT_ACTION = { DRAFT: "submitForReview", REVIEW: "submitToIC", IC_REVIEW: "approve", APPROVED: "activate", ACTIVE: "beginMonitoring", MONITORING: "close" };
const THESIS_NEXT_LABEL = { DRAFT: "Submit for review", REVIEW: "Submit to IC", IC_REVIEW: "Approve", APPROVED: "Activate", ACTIVE: "Begin monitoring", MONITORING: "Close" };

function ThesesTab({ orgId }) {
  const [theses, setTheses] = useState(null);
  const [key, setKey] = useState("");
  const [title, setTitle] = useState("");
  const [target, setTarget] = useState("");
  const [error, setError] = useState("");
  const [revising, setRevising] = useState(null);

  const load = useCallback(async () => {
    try {
      setError("");
      setTheses((await api(`/api/orgs/financial/theses?orgId=${orgId}`)).theses);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  async function create(e) {
    e.preventDefault();
    if (!key.trim() || !title.trim()) return;
    try {
      setError("");
      await api("/api/orgs/financial/theses", { method: "POST", body: JSON.stringify({ orgId, key: key.trim(), title: title.trim(), target: target.trim() || undefined }) });
      setKey(""); setTitle(""); setTarget("");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function transition(thesisId, action) {
    try {
      setError("");
      await api(`/api/orgs/financial/theses/${thesisId}/transition`, { method: "PATCH", body: JSON.stringify({ orgId, action }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  // Only the latest version per key is actionable -- listTheses() already
  // sorts {key:1, version:-1}, so the first row per key is the latest.
  const latestByKey = new Map();
  for (const t of theses || []) if (!latestByKey.has(t.key)) latestByKey.set(t.key, t);

  return (
    <div className="space-y-4">
      <form onSubmit={create} className="flex flex-wrap gap-2">
        <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="Key (e.g. ACME-LONG)" className="w-40 bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" className="flex-1 min-w-[140px] bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="Target (optional)" className="flex-1 min-w-[120px] bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <button disabled={!key.trim() || !title.trim()} className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg disabled:opacity-40">Draft thesis</button>
      </form>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!theses ? <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p> : theses.length === 0 ? (
          <EmptyState compact icon="📈" description="No investment theses yet." />
        ) : (
          <div className="space-y-2">
            {[...latestByKey.values()].map((t) => (
              <div key={t.id} className="bg-black/20 border border-white/5 rounded-lg p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <span className="text-[var(--inaya-text-primary)] text-sm">{t.title}</span>
                    <p className="text-[var(--inaya-text-muted)] text-[12px] font-mono mt-0.5 truncate">{t.key} · v{t.version}{t.target ? ` · ${t.target}` : ""}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-[11px] font-bold uppercase px-2 py-0.5 rounded-full border border-white/10 text-[var(--inaya-text-muted)]">{t.status}</span>
                    {THESIS_NEXT_ACTION[t.status] && <button onClick={() => transition(t.id, THESIS_NEXT_ACTION[t.status])} className="text-[10px] font-bold uppercase text-[#00f2fe] whitespace-nowrap">{THESIS_NEXT_LABEL[t.status]}</button>}
                    {t.status !== "DRAFT" && <button onClick={() => setRevising(revising === t.id ? null : t.id)} className="text-[10px] font-bold uppercase text-[var(--inaya-text-muted)] hover:text-slate-200 whitespace-nowrap">Revise</button>}
                  </div>
                </div>
                {revising === t.id && <ReviseThesisForm orgId={orgId} thesis={t} onDone={() => { setRevising(null); load(); }} />}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ReviseThesisForm({ orgId, thesis, onDone }) {
  const [title, setTitle] = useState(thesis.title);
  const [error, setError] = useState("");
  async function submit(e) {
    e.preventDefault();
    try {
      setError("");
      await api(`/api/orgs/financial/theses/${thesis.id}/revise`, { method: "POST", body: JSON.stringify({ orgId, updates: { title: title.trim() } }) });
      onDone();
    } catch (err) {
      setError(err.message);
    }
  }
  return (
    <form onSubmit={submit} className="mt-2 pt-2 border-t border-white/5 flex gap-2">
      <input value={title} onChange={(e) => setTitle(e.target.value)} className="flex-1 bg-black/45 border border-white/15 rounded-lg px-2.5 py-1.5 text-[11px] text-[var(--inaya-text-primary)]" />
      <button className="text-[10px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-2.5 py-1 rounded-lg">Create v{thesis.version + 1}</button>
      {error && <p className="text-red-400 text-[10px]">{error}</p>}
    </form>
  );
}

// ============================================================
// INVESTMENT COMMITTEE (Phase 2, §8)
// ============================================================
const IC_NEXT_ACTION = { DRAFT: "submit", SUBMITTED: "startResearch", UNDER_RESEARCH: "submitForComplianceReview", COMPLIANCE_REVIEW: "submitForRiskReview", RISK_REVIEW: "scheduleIC", DEFERRED: "resumeFromDeferral" };
const IC_NEXT_LABEL = { DRAFT: "Submit", SUBMITTED: "Start research", UNDER_RESEARCH: "Send to compliance review", COMPLIANCE_REVIEW: "Send to risk review", RISK_REVIEW: "Schedule IC", DEFERRED: "Resume" };
const IC_WITHDRAWABLE = ["DRAFT", "SUBMITTED", "UNDER_RESEARCH", "COMPLIANCE_REVIEW", "RISK_REVIEW", "IC_SCHEDULED"];

function CommitteeTab({ orgId }) {
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
        <input value={opportunity} onChange={(e) => setOpportunity(e.target.value)} placeholder="Opportunity description" className="flex-1 min-w-[200px] bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
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

function ICCaseDecisionPanel({ orgId, icCase, onChanged }) {
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
          <input value={finalResolution} onChange={(e) => setFinalResolution(e.target.value)} placeholder="Final resolution" className="flex-1 min-w-[140px] bg-black/45 border border-white/15 rounded-lg px-2.5 py-1.5 text-[11px] text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
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
          <input value={amendText} onChange={(e) => setAmendText(e.target.value)} placeholder="Amended final resolution" className="flex-1 bg-black/45 border border-white/15 rounded-lg px-2.5 py-1.5 text-[11px] text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
          <button className="text-[10px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-2.5 py-1 rounded-lg">Save v{(history[0]?.version || 1) + 1}</button>
          <button type="button" onClick={() => setAmending(false)} className="text-[10px] font-bold uppercase text-[var(--inaya-text-muted)]">Cancel</button>
        </form>
      )}
    </div>
  );
}

// ============================================================
// PORTFOLIO WORKSPACE (Phase 2, §9-12 — Portfolios/Positions/Exposure/
// Thresholds/Liquidity/Performance, all scoped to a chosen fund)
// ============================================================
function PortfolioTab({ orgId }) {
  const [funds, setFunds] = useState(null);
  const [fundId, setFundId] = useState("");
  const [section, setSection] = useState("portfolios");
  const SECTIONS = ["portfolios", "thresholds", "liquidity", "performance"];

  useEffect(() => {
    api(`/api/orgs/financial/funds?orgId=${orgId}`).then((d) => {
      setFunds(d.funds);
      if (d.funds.length > 0) setFundId((cur) => cur || d.funds[0].id);
    }).catch(() => setFunds([]));
  }, [orgId]);

  if (!funds) return <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>;
  if (funds.length === 0) return <EmptyState compact icon="📊" description="Register a fund first (Funds tab) before tracking a portfolio." />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <select value={fundId} onChange={(e) => setFundId(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
          {funds.map((f) => <option key={f.id} value={f.id}>{f.shortName || f.legalName}</option>)}
        </select>
        <div className="flex bg-[var(--inaya-surface)] border border-white/5 rounded-xl p-1 flex-wrap">
          {SECTIONS.map((s) => (
            <button key={s} onClick={() => setSection(s)} className={`px-3 py-1.5 text-[11px] font-bold uppercase rounded-lg ${section === s ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>{s}</button>
          ))}
        </div>
      </div>
      {section === "portfolios" && <PortfoliosAndPositionsSection orgId={orgId} fundId={fundId} />}
      {section === "thresholds" && <ThresholdsSection orgId={orgId} fundId={fundId} />}
      {section === "liquidity" && <LiquiditySection orgId={orgId} fundId={fundId} />}
      {section === "performance" && <PerformanceSection orgId={orgId} fundId={fundId} />}
    </div>
  );
}

function PortfoliosAndPositionsSection({ orgId, fundId }) {
  const [portfolios, setPortfolios] = useState(null);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setError("");
      const d = (await api(`/api/orgs/financial/portfolios?orgId=${orgId}&fundId=${fundId}`)).portfolios;
      setPortfolios(d);
      setSelected((cur) => (cur && d.some((p) => p.id === cur)) ? cur : (d[0]?.id || null));
    } catch (err) {
      setError(err.message);
    }
  }, [orgId, fundId]);

  useEffect(() => { load(); }, [load]);

  async function create(e) {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      setError("");
      await api("/api/orgs/financial/portfolios", { method: "POST", body: JSON.stringify({ orgId, fundId, name: name.trim() }) });
      setName("");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="space-y-3">
      <form onSubmit={create} className="flex flex-wrap gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New portfolio name" className="flex-1 min-w-[160px] bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <button disabled={!name.trim()} className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg disabled:opacity-40">Create portfolio</button>
      </form>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      {!portfolios ? <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p> : portfolios.length === 0 ? (
        <EmptyState compact icon="📁" description="No portfolios for this fund yet." />
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {portfolios.map((p) => (
              <button key={p.id} onClick={() => setSelected(p.id)} className={`text-[11px] font-bold px-3 py-1.5 rounded-lg border ${selected === p.id ? "bg-[#00f2fe]/15 text-[#00f2fe] border-[#00f2fe]/30" : "text-[var(--inaya-text-muted)] border-white/10"}`}>{p.name}</button>
            ))}
          </div>
          {selected && <PositionsAndExposure orgId={orgId} portfolioId={selected} />}
        </>
      )}
    </div>
  );
}

function PositionsAndExposure({ orgId, portfolioId }) {
  const [positions, setPositions] = useState(null);
  const [dashboard, setDashboard] = useState(null);
  const [security, setSecurity] = useState("");
  const [issuer, setIssuer] = useState("");
  const [marketValue, setMarketValue] = useState("");
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(null);

  const load = useCallback(async () => {
    try {
      setError("");
      const [posData, expData] = await Promise.all([
        api(`/api/orgs/financial/positions?orgId=${orgId}&portfolioId=${portfolioId}`),
        api(`/api/orgs/financial/exposure?orgId=${orgId}&portfolioId=${portfolioId}`),
      ]);
      setPositions(posData.positions);
      setDashboard(expData);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId, portfolioId]);

  useEffect(() => { load(); }, [load]);

  async function ingest(e) {
    e.preventDefault();
    if (!security.trim()) return;
    try {
      setError("");
      await api("/api/orgs/financial/positions", { method: "POST", body: JSON.stringify({ orgId, portfolioId, security: security.trim(), issuer: issuer.trim() || undefined, marketValue: marketValue ? parseFloat(marketValue) : undefined }) });
      setSecurity(""); setIssuer(""); setMarketValue("");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="mt-3 pt-3 border-t border-white/5 space-y-3">
      {dashboard && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Stat label="Gross exposure" value={dashboard.grossExposure} />
          <Stat label="Net exposure" value={dashboard.netExposure} />
          <Stat label="Long" value={dashboard.longExposure} />
          <Stat label="Short" value={dashboard.shortExposure} />
          {dashboard.unpricedPositionCount > 0 && <p className="col-span-full text-[11px] font-mono text-amber-400">{dashboard.unpricedPositionCount} position(s) unpriced — excluded from every sum above, not fabricated as zero.</p>}
        </div>
      )}
      <form onSubmit={ingest} className="flex flex-wrap gap-2">
        <input value={security} onChange={(e) => setSecurity(e.target.value)} placeholder="Security" className="flex-1 min-w-[120px] bg-black/45 border border-white/15 rounded-lg px-2.5 py-1.5 text-[11px] text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="Issuer" className="flex-1 min-w-[100px] bg-black/45 border border-white/15 rounded-lg px-2.5 py-1.5 text-[11px] text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input value={marketValue} onChange={(e) => setMarketValue(e.target.value)} type="number" placeholder="Market value" className="w-28 bg-black/45 border border-white/15 rounded-lg px-2.5 py-1.5 text-[11px] text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <button disabled={!security.trim()} className="text-[10px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-2.5 py-1.5 rounded-lg disabled:opacity-40">Ingest position</button>
      </form>
      {error && <p className="text-red-400 text-[10px]">{error}</p>}
      {!positions || positions.length === 0 ? <Empty /> : (
        <div className="space-y-1">
          {positions.map((p) => (
            <div key={p.id} className="bg-black/20 border border-white/5 rounded-lg">
              <button onClick={() => setExpanded(expanded === p.id ? null : p.id)} className="w-full flex items-center justify-between px-3 py-1.5 text-left">
                <span className="text-[var(--inaya-text-primary)] text-xs truncate">{p.security}{p.issuer ? ` (${p.issuer})` : ""}</span>
                <span className="text-[var(--inaya-text-muted)] text-[11px] font-mono shrink-0 ml-2">{p.marketValue == null ? "unpriced" : `$${p.marketValue}`}</span>
              </button>
              {expanded === p.id && <ValuationsSection orgId={orgId} positionId={p.id} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ValuationsSection({ orgId, positionId }) {
  const [valuations, setValuations] = useState(null);
  const [method, setMethod] = useState("market_price");
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const METHODS = ["market_price", "model", "third_party_pricing_service", "manager_estimate", "last_transaction", "appraisal"];

  const load = useCallback(async () => {
    try {
      setError("");
      setValuations((await api(`/api/orgs/financial/valuations?orgId=${orgId}&positionId=${positionId}`)).valuations);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId, positionId]);

  useEffect(() => { load(); }, [load]);

  async function record(e) {
    e.preventDefault();
    if (!value) return;
    try {
      setError("");
      await api("/api/orgs/financial/valuations", { method: "POST", body: JSON.stringify({ orgId, positionId, method, value: parseFloat(value) }) });
      setValue("");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function approve(valuationId) {
    try {
      setError("");
      await api(`/api/orgs/financial/valuations/${valuationId}/approve`, { method: "PATCH", body: JSON.stringify({ orgId }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="px-3 pb-2.5 pt-1 border-t border-white/5 space-y-2">
      <form onSubmit={record} className="flex flex-wrap gap-2">
        <select value={method} onChange={(e) => setMethod(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-2 py-1 text-[10px] text-[var(--inaya-text-primary)]">
          {METHODS.map((m) => <option key={m} value={m}>{m.replace(/_/g, " ")}</option>)}
        </select>
        <input value={value} onChange={(e) => setValue(e.target.value)} type="number" placeholder="Value" className="w-24 bg-black/45 border border-white/15 rounded-lg px-2 py-1 text-[10px] text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <button disabled={!value} className="text-[10px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-2.5 py-1 rounded-lg disabled:opacity-40">Record valuation</button>
      </form>
      {error && <p className="text-red-400 text-[10px]">{error}</p>}
      {!valuations || valuations.length === 0 ? <Empty /> : valuations.map((v) => (
        <div key={v.id} className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-mono text-[var(--inaya-text-muted)]">{v.method.replace(/_/g, " ")} · ${v.value}{v.approvedAt ? ` · approved by ${v.reviewerEmail}` : " · unapproved"}</span>
          {!v.approvedAt && <button onClick={() => approve(v.id)} className="text-[10px] font-bold uppercase text-[#00f2fe] shrink-0">Approve</button>}
        </div>
      ))}
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="bg-black/20 border border-white/5 rounded-lg p-2.5">
      <p className="text-[10px] font-bold uppercase text-[var(--inaya-text-muted)]">{label}</p>
      <p className="text-[var(--inaya-text-primary)] text-sm font-mono mt-0.5">${(value ?? 0).toLocaleString()}</p>
    </div>
  );
}

function ThresholdsSection({ orgId, fundId }) {
  const [thresholds, setThresholds] = useState(null);
  const [portfolios, setPortfolios] = useState(null);
  const [portfolioId, setPortfolioId] = useState("");
  const [metric, setMetric] = useState("issuer_concentration");
  const [limitValue, setLimitValue] = useState("");
  const [breaches, setBreaches] = useState(null);
  const [error, setError] = useState("");
  const METRICS = ["issuer_concentration", "sector_concentration", "leverage", "fund_exposure", "counterparty_exposure", "illiquid_exposure", "liquidity_minimum", "strategy_limit"];

  const load = useCallback(async () => {
    try {
      setError("");
      const [tData, pData] = await Promise.all([
        api(`/api/orgs/financial/thresholds?orgId=${orgId}&fundId=${fundId}`),
        api(`/api/orgs/financial/portfolios?orgId=${orgId}&fundId=${fundId}`),
      ]);
      setThresholds(tData.thresholds);
      setPortfolios(pData.portfolios);
      setPortfolioId((cur) => cur || pData.portfolios[0]?.id || "");
    } catch (err) {
      setError(err.message);
    }
  }, [orgId, fundId]);

  useEffect(() => { load(); setBreaches(null); }, [load]);

  async function set(e) {
    e.preventDefault();
    if (!limitValue) return;
    try {
      setError("");
      await api("/api/orgs/financial/thresholds", { method: "POST", body: JSON.stringify({ orgId, fundId, metric, limitValue: parseFloat(limitValue) }) });
      setLimitValue("");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function evaluate() {
    if (!portfolioId) return;
    try {
      setError("");
      const result = await api("/api/orgs/financial/thresholds", { method: "PATCH", body: JSON.stringify({ orgId, fundId, portfolioId }) });
      setBreaches(result.breaches);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="space-y-3">
      <form onSubmit={set} className="flex flex-wrap gap-2">
        <select value={metric} onChange={(e) => setMetric(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
          {METRICS.map((m) => <option key={m} value={m}>{m.replace(/_/g, " ")}</option>)}
        </select>
        <input value={limitValue} onChange={(e) => setLimitValue(e.target.value)} type="number" placeholder="Limit value" className="w-32 bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <button disabled={!limitValue} className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg disabled:opacity-40">Set threshold</button>
      </form>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5 space-y-1">
        {!thresholds || thresholds.length === 0 ? <Empty /> : thresholds.map((t, i) => <Row key={i} left={t.metric.replace(/_/g, " ")} right={t.limitValue} />)}
      </div>
      {portfolios && portfolios.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <select value={portfolioId} onChange={(e) => setPortfolioId(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
            {portfolios.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button onClick={evaluate} className="text-[11px] font-bold uppercase px-3 py-1.5 rounded-md bg-white/5 border border-white/10 text-[var(--inaya-text-primary)] hover:bg-white/10">Evaluate against this portfolio</button>
        </div>
      )}
      {breaches && (breaches.length === 0 ? (
        <p className="text-[12px] font-mono text-emerald-400">No breaches — every computed metric is within its configured limit.</p>
      ) : (
        <div className="space-y-1">
          {breaches.map((b, i) => <p key={i} className="text-[12px] font-mono text-red-400">⚠ {b.metric.replace(/_/g, " ")} breached: {b.currentValue} exceeds limit {b.limitValue} — a risk-register entry was created.</p>)}
        </div>
      ))}
    </div>
  );
}

function LiquiditySection({ orgId, fundId }) {
  const [scenarios, setScenarios] = useState(null);
  const [bucketValue, setBucketValue] = useState("");
  const [days, setDays] = useState("7");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setError("");
      setScenarios((await api(`/api/orgs/financial/liquidity/scenarios?orgId=${orgId}&fundId=${fundId}`)).scenarios);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId, fundId]);

  useEffect(() => { load(); }, [load]);

  async function run(e) {
    e.preventDefault();
    if (!bucketValue) return;
    try {
      setError("");
      await api("/api/orgs/financial/liquidity/scenarios", {
        method: "POST",
        body: JSON.stringify({ orgId, fundId, scenarioType: "normal", buckets: [{ classification: "modeled", marketValue: parseFloat(bucketValue), daysToLiquidate: parseInt(days, 10) }] }),
      });
      setBucketValue("");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="space-y-3">
      <form onSubmit={run} className="flex flex-wrap gap-2">
        <input value={bucketValue} onChange={(e) => setBucketValue(e.target.value)} type="number" placeholder="Bucket market value" className="flex-1 min-w-[140px] bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input value={days} onChange={(e) => setDays(e.target.value)} type="number" placeholder="Days to liquidate" className="w-36 bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <button disabled={!bucketValue} className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg disabled:opacity-40">Run scenario</button>
      </form>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!scenarios ? <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p> : scenarios.length === 0 ? (
          <EmptyState compact icon="💧" description="No liquidity scenarios run yet." />
        ) : (
          <div className="space-y-1">
            {scenarios.map((s) => (
              <Row key={s.id} left={`${s.scenarioType} — total $${s.totalValue}`} right={`≤7d $${s.liquidWithin7Days} · ≤30d $${s.liquidWithin30Days}`} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PerformanceSection({ orgId, fundId }) {
  const [periods, setPeriods] = useState(null);
  const [period, setPeriod] = useState("");
  const [netReturn, setNetReturn] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setError("");
      setPeriods((await api(`/api/orgs/financial/performance?orgId=${orgId}&fundId=${fundId}`)).periods);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId, fundId]);

  useEffect(() => { load(); }, [load]);

  async function record(e) {
    e.preventDefault();
    if (!period.trim()) return;
    try {
      setError("");
      await api("/api/orgs/financial/performance", { method: "POST", body: JSON.stringify({ orgId, fundId, period: period.trim(), netReturn: netReturn ? parseFloat(netReturn) : undefined }) });
      setPeriod(""); setNetReturn("");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="space-y-3">
      <form onSubmit={record} className="flex flex-wrap gap-2">
        <input value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="Period (e.g. 2026-Q1)" className="w-36 bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input value={netReturn} onChange={(e) => setNetReturn(e.target.value)} type="number" step="0.0001" placeholder="Net return (e.g. 0.032)" className="flex-1 min-w-[140px] bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <button disabled={!period.trim()} className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg disabled:opacity-40">Record period</button>
      </form>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!periods ? <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p> : periods.length === 0 ? (
          <EmptyState compact icon="📉" description="No performance periods recorded yet." />
        ) : (
          <div className="space-y-1">
            {periods.map((p, i) => (
              <Row key={i} left={p.period} right={`${p.inputs?.netReturn != null ? (p.inputs.netReturn * 100).toFixed(2) + "%" : "—"}${p.derived?.sharpe != null ? ` · Sharpe ${p.derived.sharpe.value.toFixed(2)}` : ""}`} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// PRIVATE CAPITAL: DEALS (Phase 3, §29-33 — pipeline, screening,
// diligence, term sheets, all fund-scoped like everything else here)
// ============================================================
const DEAL_NEXT_ACTION = { SOURCED: "advance", SCREENED: "advance", INITIAL_REVIEW: "advance", PARTNER_REVIEW: "advance", DILIGENCE: "advance", IC: "advance", TERM_SHEET: "advance", NEGOTIATION: "advance" };
const DILIGENCE_DOMAINS = ["commercial", "financial", "legal", "tax", "technology", "cybersecurity", "product", "market", "regulatory", "hr", "ip", "insurance", "esg", "data_protection", "vendor_risk", "operations"];
const SCORECARD_CRITERIA = ["market", "team", "product", "traction", "financials", "moat", "competition", "regulatory_risk", "technical_risk", "cybersecurity", "customer_concentration", "capital_efficiency", "valuation", "exit_potential", "strategic_fit"];

function DealsTab({ orgId }) {
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
        <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="New deal: target company" className="flex-1 min-w-[160px] bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
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

function DealDetail({ orgId, deal }) {
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

function DealScorecards({ orgId, dealId }) {
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
        <input value={score} onChange={(e) => setScore(e.target.value)} type="number" min="0" max="10" placeholder="Score 0-10" className="w-24 bg-black/45 border border-white/15 rounded-lg px-2 py-1 text-[10px] text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input value={rationale} onChange={(e) => setRationale(e.target.value)} placeholder="Rationale" className="flex-1 min-w-[120px] bg-black/45 border border-white/15 rounded-lg px-2 py-1 text-[10px] text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <button disabled={!score} className="text-[10px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-2.5 py-1 rounded-lg disabled:opacity-40">Submit score</button>
      </form>
      {error && <p className="text-red-400 text-[10px]">{error}</p>}
      {!scorecards || scorecards.length === 0 ? <Empty /> : scorecards.map((s) => (
        <Row key={s.id} left={`v${s.version} · ${s.evaluatorEmail}${s.rationale ? ` — ${s.rationale}` : ""}`} right={s.weightedScore != null ? s.weightedScore.toFixed(1) : "—"} />
      ))}
    </div>
  );
}

function DealDiligence({ orgId, dealId }) {
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
        <input value={request} onChange={(e) => setRequest(e.target.value)} placeholder="Request (e.g. audited financials)" className="flex-1 min-w-[140px] bg-black/45 border border-white/15 rounded-lg px-2 py-1 text-[10px] text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
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

function DealTermSheets({ orgId, dealId }) {
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
        <input value={valuation} onChange={(e) => setValuation(e.target.value)} type="number" placeholder="New round: valuation" className="flex-1 min-w-[140px] bg-black/45 border border-white/15 rounded-lg px-2 py-1 text-[10px] text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
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

// ============================================================
// PRIVATE CAPITAL: PORTFOLIO COMPANIES (Phase 3, §35-39 — board, value
// creation, KPIs/monitoring, all attached to a portfolio company)
// ============================================================
function PrivateCapitalPortfolioTab({ orgId }) {
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

function PortfolioCompanyWorkspace({ orgId, portfolioCompanyId }) {
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

function BoardSection({ orgId, portfolioCompanyId }) {
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

function ResolutionsSection({ orgId, meetingId }) {
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
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Propose resolution" className="flex-1 bg-black/45 border border-white/15 rounded-lg px-2 py-1 text-[10px] text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
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

function ValueCreationSection({ orgId, portfolioCompanyId }) {
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
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Plan title" className="flex-1 min-w-[140px] bg-black/45 border border-white/15 rounded-lg px-2 py-1 text-[10px] text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
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

function KpiSection({ orgId, portfolioCompanyId }) {
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
        <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="Key (e.g. arr)" className="w-28 bg-black/45 border border-white/15 rounded-lg px-2 py-1 text-[10px] text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label (e.g. ARR)" className="flex-1 min-w-[100px] bg-black/45 border border-white/15 rounded-lg px-2 py-1 text-[10px] text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
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

function KpiRow({ kpi, onRecord }) {
  const [period, setPeriod] = useState("");
  const [value, setValue] = useState("");
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[11px] text-[var(--inaya-text-primary)] w-24 truncate">{kpi.label}</span>
      <span className="text-[10px] font-mono text-[var(--inaya-text-muted)]">{kpi.values.map((v) => `${v.period}:${v.value}`).join(" ") || "no data"}</span>
      <input value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="Period" className="w-20 bg-black/45 border border-white/15 rounded-lg px-1.5 py-0.5 text-[10px] text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
      <input value={value} onChange={(e) => setValue(e.target.value)} type="number" placeholder="Value" className="w-20 bg-black/45 border border-white/15 rounded-lg px-1.5 py-0.5 text-[10px] text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
      <button onClick={() => { onRecord(kpi.id, period, value); setPeriod(""); setValue(""); }} disabled={!period || !value} className="text-[10px] font-bold uppercase text-[#00f2fe] disabled:opacity-40">Record</button>
    </div>
  );
}

function CapTableSection({ orgId, portfolioCompanyId }) {
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
        <input value={holderName} onChange={(e) => setHolderName(e.target.value)} placeholder="Holder name" className="flex-1 min-w-[120px] bg-black/45 border border-white/15 rounded-lg px-2 py-1 text-[10px] text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input value={shares} onChange={(e) => setShares(e.target.value)} type="number" placeholder="Fully diluted shares" className="w-40 bg-black/45 border border-white/15 rounded-lg px-2 py-1 text-[10px] text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
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

// ============================================================
// PRIVATE CAPITAL: FUNDRAISING (Phase 3, §40 — LP pipeline)
// ============================================================
function FundraisingTab({ orgId }) {
  const [funds, setFunds] = useState(null);
  const [fundId, setFundId] = useState("");
  const [prospects, setProspects] = useState(null);
  const [legalName, setLegalName] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api(`/api/orgs/financial/funds?orgId=${orgId}`).then((d) => { setFunds(d.funds); if (d.funds.length > 0) setFundId((cur) => cur || d.funds[0].id); }).catch(() => setFunds([]));
  }, [orgId]);

  const load = useCallback(async () => {
    if (!fundId) return;
    try {
      setError("");
      setProspects((await api(`/api/orgs/private-capital/fundraising?orgId=${orgId}&fundId=${fundId}`)).prospects);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId, fundId]);

  useEffect(() => { load(); }, [load]);

  async function create(e) {
    e.preventDefault();
    if (!legalName.trim() || !fundId) return;
    try {
      setError("");
      await api("/api/orgs/private-capital/fundraising", { method: "POST", body: JSON.stringify({ orgId, fundId, legalName: legalName.trim() }) });
      setLegalName("");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function act(prospectId, action) {
    try {
      setError("");
      await api("/api/orgs/private-capital/fundraising", { method: "PATCH", body: JSON.stringify({ orgId, prospectId, action }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function convert(prospectId) {
    try {
      setError("");
      await api(`/api/orgs/private-capital/fundraising/${prospectId}/convert`, { method: "POST", body: JSON.stringify({ orgId }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  if (!funds) return <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>;
  if (funds.length === 0) return <EmptyState compact icon="💰" description="Register a fund first (Funds tab) before raising capital for it." />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <select value={fundId} onChange={(e) => setFundId(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
          {funds.map((f) => <option key={f.id} value={f.id}>{f.shortName || f.legalName}</option>)}
        </select>
        <input value={legalName} onChange={(e) => setLegalName(e.target.value)} placeholder="New LP prospect" className="flex-1 min-w-[160px] bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <button onClick={create} disabled={!legalName.trim()} className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg disabled:opacity-40">Add prospect</button>
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!prospects || prospects.length === 0 ? <EmptyState compact icon="💰" description="No LP prospects yet." /> : (
          <div className="space-y-2">
            {prospects.map((p) => (
              <div key={p.id} className="flex items-center justify-between gap-3 bg-black/20 border border-white/5 rounded-lg p-3">
                <span className="text-[var(--inaya-text-primary)] text-sm truncate">{p.legalName}</span>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[11px] font-bold uppercase px-2 py-0.5 rounded-full border border-white/10 text-[var(--inaya-text-muted)]">{p.stage.replace(/_/g, " ")}</span>
                  {p.stage !== "LEGAL_DOCS" && p.stage !== "CLOSED" && p.stage !== "PASSED" && <button onClick={() => act(p.id, "advance")} className="text-[10px] font-bold uppercase text-[#00f2fe]">Advance</button>}
                  {p.stage === "LEGAL_DOCS" && <button onClick={() => convert(p.id)} className="text-[10px] font-bold uppercase text-emerald-400">Convert to investor</button>}
                  {!["CLOSED", "PASSED"].includes(p.stage) && <button onClick={() => act(p.id, "pass")} className="text-[10px] font-bold uppercase text-[var(--inaya-text-muted)] hover:text-red-400">Pass</button>}
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
// PRIVATE CAPITAL: EXITS (Phase 3, §41)
// ============================================================
function ExitsTab({ orgId }) {
  const [companies, setCompanies] = useState(null);
  const [companyId, setCompanyId] = useState("");
  const [exits, setExits] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api(`/api/orgs/private-capital/portfolio-companies?orgId=${orgId}`).then((d) => { setCompanies(d.portfolioCompanies); if (d.portfolioCompanies.length > 0) setCompanyId((cur) => cur || d.portfolioCompanies[0].id); }).catch(() => setCompanies([]));
  }, [orgId]);

  const load = useCallback(async () => {
    if (!companyId) return;
    try {
      setError("");
      setExits((await api(`/api/orgs/private-capital/exits?orgId=${orgId}&portfolioCompanyId=${companyId}`)).exits);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId, companyId]);

  useEffect(() => { load(); }, [load]);

  async function start() {
    try {
      setError("");
      await api("/api/orgs/private-capital/exits", { method: "POST", body: JSON.stringify({ orgId, portfolioCompanyId: companyId }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function act(exitId, action) {
    try {
      setError("");
      await api("/api/orgs/private-capital/exits", { method: "PATCH", body: JSON.stringify({ orgId, exitId, action }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function beginClosingExit(exitId) {
    try {
      setError("");
      await api(`/api/orgs/private-capital/exits/${exitId}/begin-closing`, { method: "PATCH", body: JSON.stringify({ orgId }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  const NEXT = { READINESS: "beginOutreach", BUYER_OUTREACH: "beginDiligence", DILIGENCE: "receiveBids", BIDS_RECEIVED: "negotiate" };

  if (!companies) return <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>;
  if (companies.length === 0) return <EmptyState compact icon="🚪" description="No portfolio companies yet -- an exit needs one." />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 items-center">
        <select value={companyId} onChange={(e) => setCompanyId(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
          {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button onClick={start} className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg">Start exit process</button>
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!exits || exits.length === 0 ? <EmptyState compact icon="🚪" description="No exit process started for this company." /> : (
          <div className="space-y-2">
            {exits.map((ex) => (
              <div key={ex.id} className="bg-black/20 border border-white/5 rounded-lg p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[var(--inaya-text-primary)] text-sm">{ex.exitType || "Exit"} · {ex.bids.length} bid(s)</span>
                  <span className="text-[11px] font-bold uppercase px-2 py-0.5 rounded-full border border-white/10 text-[var(--inaya-text-muted)]">{ex.status.replace(/_/g, " ")}</span>
                </div>
                <div className="flex flex-wrap gap-2 mt-2 items-center">
                  {NEXT[ex.status] && <button onClick={() => act(ex.id, NEXT[ex.status])} className="text-[10px] font-bold uppercase text-[#00f2fe]">{NEXT[ex.status]}</button>}
                  {ex.status === "DILIGENCE" && <ExitBidForm orgId={orgId} exitId={ex.id} onDone={load} />}
                  {ex.status === "NEGOTIATION" && <ExitApproveForm orgId={orgId} exitId={ex.id} onDone={load} />}
                  {ex.status === "IC_APPROVED" && <button onClick={() => beginClosingExit(ex.id)} className="text-[10px] font-bold uppercase text-[#00f2fe]">Begin closing</button>}
                  {ex.status === "CLOSING" && <button onClick={() => act(ex.id, "close")} className="text-[10px] font-bold uppercase text-emerald-400">Close</button>}
                  {ex.status === "CLOSED" && <ExitDistributionForm orgId={orgId} exitId={ex.id} distributionAmount={ex.distributionAmount} onDone={load} />}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ExitBidForm({ orgId, exitId, onDone }) {
  const [buyerName, setBuyerName] = useState("");
  const [amount, setAmount] = useState("");
  async function submit(e) {
    e.preventDefault();
    if (!buyerName.trim() || !amount) return;
    await api(`/api/orgs/private-capital/exits/${exitId}/bids`, { method: "POST", body: JSON.stringify({ orgId, buyerName: buyerName.trim(), buyerType: "strategic", amount: parseFloat(amount) }) });
    setBuyerName(""); setAmount("");
    onDone();
  }
  return (
    <form onSubmit={submit} className="flex gap-2">
      <input value={buyerName} onChange={(e) => setBuyerName(e.target.value)} placeholder="Buyer" className="bg-black/45 border border-white/15 rounded-lg px-2 py-1 text-[10px] text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
      <input value={amount} onChange={(e) => setAmount(e.target.value)} type="number" placeholder="Bid amount" className="w-28 bg-black/45 border border-white/15 rounded-lg px-2 py-1 text-[10px] text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
      <button disabled={!buyerName.trim() || !amount} className="text-[10px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-2.5 py-1 rounded-lg disabled:opacity-40">Record bid</button>
    </form>
  );
}

function ExitApproveForm({ orgId, exitId, onDone }) {
  const [icDecisionId, setIcDecisionId] = useState("");
  const [error, setError] = useState("");
  async function submit(e) {
    e.preventDefault();
    if (!icDecisionId.trim()) return;
    try {
      setError("");
      await api(`/api/orgs/private-capital/exits/${exitId}/approve`, { method: "PATCH", body: JSON.stringify({ orgId, icDecisionId: icDecisionId.trim() }) });
      setIcDecisionId("");
      onDone();
    } catch (err) {
      setError(err.message);
    }
  }
  return (
    <form onSubmit={submit} className="flex flex-wrap gap-2 items-center">
      <input value={icDecisionId} onChange={(e) => setIcDecisionId(e.target.value)} placeholder="IC decision ID (from Committee tab)" className="w-56 bg-black/45 border border-white/15 rounded-lg px-2 py-1 text-[10px] text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
      <button disabled={!icDecisionId.trim()} className="text-[10px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-2.5 py-1 rounded-lg disabled:opacity-40">Approve exit</button>
      {error && <p className="text-red-400 text-[10px] w-full">{error}</p>}
    </form>
  );
}

function ExitDistributionForm({ orgId, exitId, distributionAmount, onDone }) {
  const [amount, setAmount] = useState("");
  if (distributionAmount != null) return <span className="text-[11px] font-mono text-emerald-400">Distributed: ${distributionAmount}</span>;
  async function submit(e) {
    e.preventDefault();
    if (!amount) return;
    await api(`/api/orgs/private-capital/exits/${exitId}/distribution`, { method: "PATCH", body: JSON.stringify({ orgId, distributionAmount: parseFloat(amount) }) });
    setAmount("");
    onDone();
  }
  return (
    <form onSubmit={submit} className="flex gap-2">
      <input value={amount} onChange={(e) => setAmount(e.target.value)} type="number" placeholder="Distribution amount" className="w-36 bg-black/45 border border-white/15 rounded-lg px-2 py-1 text-[10px] text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
      <button disabled={!amount} className="text-[10px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-2.5 py-1 rounded-lg disabled:opacity-40">Record distribution</button>
    </form>
  );
}

// ============================================================
// PRIVATE CAPITAL: SPVs (Phase 3, §42)
// ============================================================
function SpvsTab({ orgId }) {
  const [spvs, setSpvs] = useState(null);
  const [name, setName] = useState("");
  const [underlyingAsset, setUnderlyingAsset] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setError("");
      setSpvs((await api(`/api/orgs/private-capital/spvs?orgId=${orgId}`)).spvs);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  async function create(e) {
    e.preventDefault();
    if (!name.trim() || !underlyingAsset.trim()) return;
    try {
      setError("");
      await api("/api/orgs/private-capital/spvs", { method: "POST", body: JSON.stringify({ orgId, name: name.trim(), underlyingAsset: underlyingAsset.trim() }) });
      setName(""); setUnderlyingAsset("");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={create} className="flex flex-wrap gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="SPV name" className="flex-1 min-w-[140px] bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input value={underlyingAsset} onChange={(e) => setUnderlyingAsset(e.target.value)} placeholder="Underlying asset" className="flex-1 min-w-[140px] bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <button disabled={!name.trim() || !underlyingAsset.trim()} className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg disabled:opacity-40">Register SPV</button>
      </form>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!spvs || spvs.length === 0 ? <EmptyState compact icon="📦" description="No SPVs registered yet." /> : (
          <div className="space-y-2">{spvs.map((s) => <Row key={s.id} left={s.underlyingAsset} right={`${(s.expenses || []).length} expense(s)`} />)}</div>
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
