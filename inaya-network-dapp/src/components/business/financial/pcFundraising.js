"use client";

// src/components/business/financial/pcFundraising.js — PRIVATE CAPITAL: FUNDRAISING (Phase 3, §40 — LP pipeline)
// Moved verbatim from FinancialView.js (Business Workspace gap closure, Batch 3).

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../../EmptyState";
import { api } from "./shared.js";

// ============================================================
// PRIVATE CAPITAL: FUNDRAISING (Phase 3, §40 — LP pipeline)
// ============================================================
export function FundraisingTab({ orgId }) {
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
        <input aria-label="New LP prospect" value={legalName} onChange={(e) => setLegalName(e.target.value)} placeholder="New LP prospect" className="flex-1 min-w-[160px] bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
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
