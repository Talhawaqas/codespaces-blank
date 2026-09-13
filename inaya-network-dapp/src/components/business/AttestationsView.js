"use client";

// src/components/business/AttestationsView.js
//
// Cryptographic Financial Attestation — Four High-Impact Business
// Workspace Extensions SOW, Feature 4. NOT a zero-knowledge proof — see
// financial-attestation.js's header comment for exactly what this is
// (a hash-commitment + server-attested computation over real data) and
// why (no ZK proving system exists in this codebase's dependencies).

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../EmptyState";

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

const STATEMENT_LABELS = { revenue_threshold: "Revenue ≥ threshold", expense_threshold: "Expenses ≤ threshold" };

export default function AttestationsView({ orgId }) {
  const [attestations, setAttestations] = useState(null);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [verifyingId, setVerifyingId] = useState(null);
  const [verification, setVerification] = useState(null);

  const load = useCallback(async () => {
    try {
      setAttestations((await api(`/api/orgs/attestations?orgId=${orgId}`)).attestations);
    } catch (err) { setError(err.message); }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  async function handleVerify(id) {
    setVerifyingId(id); setVerification(null); setError("");
    try {
      setVerification(await api(`/api/orgs/attestations/${id}/verify?orgId=${orgId}`));
    } catch (err) { setError(err.message); } finally { setVerifyingId(null); }
  }

  return (
    <div className="space-y-4">
      <div className="bg-amber-400/10 border border-amber-400/30 rounded-xl p-3">
        <p className="text-amber-400 text-xs font-semibold">Cryptographic hash-commitment + attested computation over real financial data — not a zero-knowledge proof, and not a government/tax/regulatory certification.</p>
      </div>
      <div className="flex items-center justify-end">
        <button onClick={() => setShowCreate(true)} className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg">+ New attestation</button>
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-2xl p-5">
        {!attestations ? <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p> : attestations.length === 0 ? (
          <EmptyState compact icon="🔏" description="No attestations generated yet." ctaLabel="Create one" onCta={() => setShowCreate(true)} />
        ) : (
          <div className="space-y-2">
            {attestations.map((a) => (
              <div key={a.id} className="bg-black/20 border border-white/5 rounded-lg p-3">
                <div className="flex items-center justify-between">
                  <span className="text-[var(--inaya-text-primary)] text-sm">{STATEMENT_LABELS[a.statementType] || a.statementType}</span>
                  <span className={a.result === "SATISFIED" ? "text-emerald-400 text-xs font-bold uppercase" : "text-red-400 text-xs font-bold uppercase"}>{a.result}</span>
                </div>
                <p className="text-[var(--inaya-text-muted)] text-[11px] font-mono mt-0.5">{a.period.startDate.slice(0, 10)} → {a.period.endDate.slice(0, 10)} · threshold {a.statementParams.threshold} {a.statementParams.currency}</p>
                <p className="text-[var(--inaya-text-muted)] text-[10px] font-mono mt-0.5 truncate">{a.datasetCommitment}</p>
                <button onClick={() => handleVerify(a.id)} disabled={verifyingId === a.id} className="mt-2 text-[11px] font-bold uppercase px-2 py-1 rounded-md bg-[#00f2fe]/10 text-[#00f2fe] border border-[#00f2fe]/30 disabled:opacity-40">{verifyingId === a.id ? "Verifying…" : "Verify independently"}</button>
                {verification && verifyingId === null && (
                  <p className={`text-xs mt-2 font-bold ${verification.verificationResult === "VALID" ? "text-emerald-400" : "text-red-400"}`}>{verification.verificationResult}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      {showCreate && <CreateAttestationModal orgId={orgId} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load(); }} />}
    </div>
  );
}

function CreateAttestationModal({ orgId, onClose, onCreated }) {
  const [statementType, setStatementType] = useState("revenue_threshold");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [threshold, setThreshold] = useState("");
  const [displayCurrency, setDisplayCurrency] = useState("USD");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!startDate || !endDate || !threshold) return;
    setSubmitting(true); setError(""); setResult(null);
    try {
      const res = await api("/api/orgs/attestations", {
        method: "POST",
        body: JSON.stringify({ orgId, statementType, startDate: new Date(startDate).toISOString(), endDate: new Date(endDate).toISOString(), threshold: Number(threshold), displayCurrency }),
      });
      setResult(res);
      setTimeout(() => onCreated(), 1200);
    } catch (err) { setError(err.message); } finally { setSubmitting(false); }
  }

  return (
    <Modal title="New attestation" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-3">
        <select value={statementType} onChange={(e) => setStatementType(e.target.value)} className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
          <option value="revenue_threshold">Revenue ≥ threshold</option>
          <option value="expense_threshold">Expenses ≤ threshold</option>
        </select>
        <div className="grid grid-cols-2 gap-2">
          <input value={startDate} onChange={(e) => setStartDate(e.target.value)} type="date" required className="bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]" />
          <input value={endDate} onChange={(e) => setEndDate(e.target.value)} type="date" required className="bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]" />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <input value={threshold} onChange={(e) => setThreshold(e.target.value)} type="number" min="0" required placeholder="Threshold" className="bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]" />
          <select value={displayCurrency} onChange={(e) => setDisplayCurrency(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
            {["USD", "EUR", "GBP", "AED", "PKR"].map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        {error && <p className="text-red-400 text-xs">{error}</p>}
        {result && <p className="text-emerald-400 text-xs">Generated — result: {result.result}</p>}
        <button disabled={submitting || !startDate || !endDate || !threshold} className="w-full py-2.5 rounded-xl text-xs font-bold uppercase tracking-wide bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40">{submitting ? "Generating…" : "Generate attestation"}</button>
      </form>
    </Modal>
  );
}

function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="bg-[var(--inaya-surface)] border border-white/10 rounded-2xl p-5 w-full max-w-md max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between gap-3 mb-4">
          <h3 className="text-[var(--inaya-text-primary)] font-bold text-sm truncate">{title}</h3>
          <button onClick={onClose} className="text-[var(--inaya-text-muted)] hover:text-[var(--inaya-text-primary)] text-lg leading-none shrink-0">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
