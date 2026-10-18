"use client";

// src/components/business/financial/entities.js — ENTITIES
// Moved verbatim from FinancialView.js (Business Workspace gap closure, Batch 3).

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../../EmptyState";
import { Row, api } from "./shared.js";

// ============================================================
// ENTITIES
// ============================================================
export function EntitiesTab({ orgId }) {
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
        <input aria-label="Entity name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Entity name" className="flex-1 min-w-[160px] bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
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
