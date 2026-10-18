"use client";

// src/components/business/financial/counterparties.js — COUNTERPARTIES
// Moved verbatim from FinancialView.js (Business Workspace gap closure, Batch 3).

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../../EmptyState";
import { api } from "./shared.js";

// ============================================================
// COUNTERPARTIES
// ============================================================
export const NEXT_ONBOARDING_ACTION = { REQUESTED: "sendQuestionnaire", QUESTIONNAIRE: "submitForRiskAssessment", RISK_ASSESSMENT: "submitForLegalReview", LEGAL_REVIEW: "approve", APPROVED: "contract", CONTRACTED: "beginMonitoring" };
export const NEXT_ONBOARDING_LABEL = { REQUESTED: "Send questionnaire", QUESTIONNAIRE: "Submit for risk assessment", RISK_ASSESSMENT: "Submit for legal review", LEGAL_REVIEW: "Approve", APPROVED: "Contract", CONTRACTED: "Begin monitoring" };

export function CounterpartiesTab({ orgId }) {
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
        <input aria-label="Counterparty name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Counterparty name" className="flex-1 min-w-[160px] bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
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
