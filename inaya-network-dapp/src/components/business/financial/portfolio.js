"use client";

// src/components/business/financial/portfolio.js — PORTFOLIO WORKSPACE (Phase 2, §9-12 — Portfolios/Positions/Exposure/ Thresholds/Liquidity/Performance, all scoped to a chosen fund)
// Moved verbatim from FinancialView.js (Business Workspace gap closure, Batch 3).

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../../EmptyState";
import { Empty, Row, api } from "./shared.js";

// ============================================================
// PORTFOLIO WORKSPACE (Phase 2, §9-12 — Portfolios/Positions/Exposure/
// Thresholds/Liquidity/Performance, all scoped to a chosen fund)
// ============================================================
export function PortfolioTab({ orgId }) {
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

export function PortfoliosAndPositionsSection({ orgId, fundId }) {
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
        <input aria-label="New portfolio name" value={name} onChange={(e) => setName(e.target.value)} placeholder="New portfolio name" className="flex-1 min-w-[160px] bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
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

export function PositionsAndExposure({ orgId, portfolioId }) {
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
        <input aria-label="Security" value={security} onChange={(e) => setSecurity(e.target.value)} placeholder="Security" className="flex-1 min-w-[120px] bg-black/45 border border-white/15 rounded-lg px-2.5 py-1.5 text-[11px] text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input aria-label="Issuer" value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="Issuer" className="flex-1 min-w-[100px] bg-black/45 border border-white/15 rounded-lg px-2.5 py-1.5 text-[11px] text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input aria-label="Market value" value={marketValue} onChange={(e) => setMarketValue(e.target.value)} type="number" placeholder="Market value" className="w-28 bg-black/45 border border-white/15 rounded-lg px-2.5 py-1.5 text-[11px] text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
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

export function ValuationsSection({ orgId, positionId }) {
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
        <input aria-label="Value" value={value} onChange={(e) => setValue(e.target.value)} type="number" placeholder="Value" className="w-24 bg-black/45 border border-white/15 rounded-lg px-2 py-1 text-[10px] text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
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

export function Stat({ label, value }) {
  return (
    <div className="bg-black/20 border border-white/5 rounded-lg p-2.5">
      <p className="text-[10px] font-bold uppercase text-[var(--inaya-text-muted)]">{label}</p>
      <p className="text-[var(--inaya-text-primary)] text-sm font-mono mt-0.5">${(value ?? 0).toLocaleString()}</p>
    </div>
  );
}

export function ThresholdsSection({ orgId, fundId }) {
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
        <input aria-label="Limit value" value={limitValue} onChange={(e) => setLimitValue(e.target.value)} type="number" placeholder="Limit value" className="w-32 bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
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

export function LiquiditySection({ orgId, fundId }) {
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
        <input aria-label="Bucket market value" value={bucketValue} onChange={(e) => setBucketValue(e.target.value)} type="number" placeholder="Bucket market value" className="flex-1 min-w-[140px] bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input aria-label="Days to liquidate" value={days} onChange={(e) => setDays(e.target.value)} type="number" placeholder="Days to liquidate" className="w-36 bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
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

export function PerformanceSection({ orgId, fundId }) {
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
        <input aria-label="Period (e.g. 2026-Q1)" value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="Period (e.g. 2026-Q1)" className="w-36 bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input aria-label="Net return (e.g. 0.032)" value={netReturn} onChange={(e) => setNetReturn(e.target.value)} type="number" step="0.0001" placeholder="Net return (e.g. 0.032)" className="flex-1 min-w-[140px] bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
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
