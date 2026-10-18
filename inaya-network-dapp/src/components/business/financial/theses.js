"use client";

// src/components/business/financial/theses.js — INVESTMENT THESES (Phase 2, §7 — versioned, never overwritten)
// Moved verbatim from FinancialView.js (Business Workspace gap closure, Batch 3).

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../../EmptyState";
import { api } from "./shared.js";

// ============================================================
// INVESTMENT THESES (Phase 2, §7 — versioned, never overwritten)
// ============================================================
export const THESIS_NEXT_ACTION = { DRAFT: "submitForReview", REVIEW: "submitToIC", IC_REVIEW: "approve", APPROVED: "activate", ACTIVE: "beginMonitoring", MONITORING: "close" };
export const THESIS_NEXT_LABEL = { DRAFT: "Submit for review", REVIEW: "Submit to IC", IC_REVIEW: "Approve", APPROVED: "Activate", ACTIVE: "Begin monitoring", MONITORING: "Close" };

export function ThesesTab({ orgId }) {
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
        <input aria-label="Key (e.g. ACME-LONG)" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Key (e.g. ACME-LONG)" className="w-40 bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input aria-label="Title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" className="flex-1 min-w-[140px] bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input aria-label="Target (optional)" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="Target (optional)" className="flex-1 min-w-[120px] bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
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

export function ReviseThesisForm({ orgId, thesis, onDone }) {
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
