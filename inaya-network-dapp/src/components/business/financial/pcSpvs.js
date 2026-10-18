"use client";

// src/components/business/financial/pcSpvs.js — PRIVATE CAPITAL: SPVs (Phase 3, §42)
// Moved verbatim from FinancialView.js (Business Workspace gap closure, Batch 3).

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../../EmptyState";
import { Row, api } from "./shared.js";

// ============================================================
// PRIVATE CAPITAL: SPVs (Phase 3, §42)
// ============================================================
export function SpvsTab({ orgId }) {
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
        <input aria-label="SPV name" value={name} onChange={(e) => setName(e.target.value)} placeholder="SPV name" className="flex-1 min-w-[140px] bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input aria-label="Underlying asset" value={underlyingAsset} onChange={(e) => setUnderlyingAsset(e.target.value)} placeholder="Underlying asset" className="flex-1 min-w-[140px] bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
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
