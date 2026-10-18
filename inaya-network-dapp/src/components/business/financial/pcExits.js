"use client";

// src/components/business/financial/pcExits.js — PRIVATE CAPITAL: EXITS (Phase 3, §41)
// Moved verbatim from FinancialView.js (Business Workspace gap closure, Batch 3).

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../../EmptyState";
import { api } from "./shared.js";

// ============================================================
// PRIVATE CAPITAL: EXITS (Phase 3, §41)
// ============================================================
export function ExitsTab({ orgId }) {
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

export function ExitBidForm({ orgId, exitId, onDone }) {
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
      <input aria-label="Buyer" value={buyerName} onChange={(e) => setBuyerName(e.target.value)} placeholder="Buyer" className="bg-black/45 border border-white/15 rounded-lg px-2 py-1 text-[10px] text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
      <input aria-label="Bid amount" value={amount} onChange={(e) => setAmount(e.target.value)} type="number" placeholder="Bid amount" className="w-28 bg-black/45 border border-white/15 rounded-lg px-2 py-1 text-[10px] text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
      <button disabled={!buyerName.trim() || !amount} className="text-[10px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-2.5 py-1 rounded-lg disabled:opacity-40">Record bid</button>
    </form>
  );
}

export function ExitApproveForm({ orgId, exitId, onDone }) {
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
      <input aria-label="IC decision ID (from Committee tab)" value={icDecisionId} onChange={(e) => setIcDecisionId(e.target.value)} placeholder="IC decision ID (from Committee tab)" className="w-56 bg-black/45 border border-white/15 rounded-lg px-2 py-1 text-[10px] text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
      <button disabled={!icDecisionId.trim()} className="text-[10px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-2.5 py-1 rounded-lg disabled:opacity-40">Approve exit</button>
      {error && <p className="text-red-400 text-[10px] w-full">{error}</p>}
    </form>
  );
}

export function ExitDistributionForm({ orgId, exitId, distributionAmount, onDone }) {
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
      <input aria-label="Distribution amount" value={amount} onChange={(e) => setAmount(e.target.value)} type="number" placeholder="Distribution amount" className="w-36 bg-black/45 border border-white/15 rounded-lg px-2 py-1 text-[10px] text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
      <button disabled={!amount} className="text-[10px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-2.5 py-1 rounded-lg disabled:opacity-40">Record distribution</button>
    </form>
  );
}
