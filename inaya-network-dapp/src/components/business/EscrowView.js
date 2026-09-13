"use client";

// src/components/business/EscrowView.js
//
// Milestone Escrow — Four High-Impact Business Workspace Extensions SOW,
// Feature 3. Off-chain, approval-gated escrow RECORDS over the real
// payments ledger — never described as non-custodial on-chain escrow
// anywhere here, see escrow-workflow.js's header comment. Release goes
// through the existing AI Action Requests approval queue (propose here,
// approve/reject in the AI Action Requests view, executed by the cron
// after the 36h delay) — this view deliberately has no "release" button.

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../EmptyState";

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

const STATUS_STYLE = {
  DRAFT: "bg-white/5 text-[var(--inaya-text-muted)] border-white/10",
  AWAITING_FUNDING: "bg-amber-400/10 text-amber-400 border-amber-400/30",
  FUNDED: "bg-[#00f2fe]/10 text-[#00f2fe] border-[#00f2fe]/30",
  ACTIVE: "bg-emerald-400/10 text-emerald-400 border-emerald-400/30",
  PARTIALLY_RELEASED: "bg-amber-400/10 text-amber-400 border-amber-400/30",
  FULLY_RELEASED: "bg-emerald-400/10 text-emerald-400 border-emerald-400/30",
  DISPUTED: "bg-red-400/10 text-red-400 border-red-400/30",
  CANCELLED: "bg-white/5 text-[var(--inaya-text-muted)] border-white/10",
  REFUNDED: "bg-violet-400/10 text-violet-300 border-violet-400/30",
};

export default function EscrowView({ orgId }) {
  const [escrows, setEscrows] = useState(null);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [selected, setSelected] = useState(null);

  const load = useCallback(async () => {
    try {
      setEscrows((await api(`/api/orgs/escrow?orgId=${orgId}`)).escrows);
    } catch (err) { setError(err.message); }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-4">
      <div className="bg-amber-400/10 border border-amber-400/30 rounded-xl p-3">
        <p className="text-amber-400 text-xs font-semibold">Off-chain, approval-gated escrow records — not non-custodial on-chain escrow. Releases require a separate approval + 36-hour delay via AI Action Requests.</p>
      </div>
      <div className="flex items-center justify-end">
        <button onClick={() => setShowCreate(true)} className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg">+ New escrow</button>
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-[var(--inaya-border)] rounded-2xl p-5">
        {!escrows ? <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p> : escrows.length === 0 ? (
          <EmptyState compact icon="🤝" description="No escrows yet." ctaLabel="Create one" onCta={() => setShowCreate(true)} />
        ) : (
          <div className="space-y-2">
            {escrows.map((e) => (
              <button key={e.id} onClick={() => setSelected(e.id)} className="w-full flex items-center justify-between gap-3 bg-black/20 border border-white/5 rounded-lg p-3 text-left hover:bg-white/5">
                <div className="min-w-0">
                  <span className="text-[var(--inaya-text-primary)] text-sm">{e.currency} {e.totalAmount.toFixed(2)} · {e.milestones.length} milestone{e.milestones.length === 1 ? "" : "s"}</span>
                  <p className="text-[var(--inaya-text-muted)] text-[12px] font-mono mt-0.5">{new Date(e.createdAt).toLocaleDateString()}</p>
                </div>
                <span className={`text-[11px] font-bold uppercase px-2 py-0.5 rounded-full border shrink-0 ${STATUS_STYLE[e.status] || STATUS_STYLE.DRAFT}`}>{e.status.replace(/_/g, " ")}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {showCreate && <CreateEscrowModal orgId={orgId} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load(); }} />}
      {selected && <EscrowDetailModal orgId={orgId} escrowId={selected} onClose={() => setSelected(null)} onChanged={load} />}
    </div>
  );
}

function CreateEscrowModal({ orgId, onClose, onCreated }) {
  const [purchaseOrderId, setPurchaseOrderId] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [milestones, setMilestones] = useState([{ description: "", amount: "" }]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  function updateMilestone(i, field, value) {
    setMilestones((prev) => prev.map((m, idx) => (idx === i ? { ...m, [field]: value } : m)));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!purchaseOrderId.trim()) return;
    setSubmitting(true); setError("");
    try {
      const validMilestones = milestones.filter((m) => m.description.trim() && Number(m.amount) > 0).map((m) => ({ description: m.description.trim(), amount: Number(m.amount) }));
      await api("/api/orgs/escrow", { method: "POST", body: JSON.stringify({ orgId, purchaseOrderId: purchaseOrderId.trim(), currency, milestones: validMilestones }) });
      onCreated();
    } catch (err) { setError(err.message); } finally { setSubmitting(false); }
  }

  return (
    <Modal title="New escrow" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-3">
        <input value={purchaseOrderId} onChange={(e) => setPurchaseOrderId(e.target.value)} required placeholder="Purchase Order ID" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <select value={currency} onChange={(e) => setCurrency(e.target.value)} className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
          {["USD", "EUR", "GBP", "AED", "PKR"].map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <div className="space-y-2">
          <p className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)]">Milestones</p>
          {milestones.map((m, i) => (
            <div key={i} className="grid grid-cols-[1fr_100px] gap-1.5">
              <input value={m.description} onChange={(e) => updateMilestone(i, "description", e.target.value)} placeholder="Description" className="bg-black/45 border border-white/15 rounded-lg px-2 py-1.5 text-xs text-[var(--inaya-text-primary)]" />
              <input value={m.amount} onChange={(e) => updateMilestone(i, "amount", e.target.value)} type="number" min="0" placeholder="Amount" className="bg-black/45 border border-white/15 rounded-lg px-2 py-1.5 text-xs text-[var(--inaya-text-primary)]" />
            </div>
          ))}
          <button type="button" onClick={() => setMilestones((prev) => [...prev, { description: "", amount: "" }])} className="text-[11px] font-bold text-[#00f2fe]">+ Add milestone</button>
        </div>
        {error && <p className="text-red-400 text-xs">{error}</p>}
        <button disabled={submitting || !purchaseOrderId.trim()} className="w-full py-2.5 rounded-xl text-xs font-bold uppercase tracking-wide bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40">{submitting ? "Creating…" : "Create escrow"}</button>
      </form>
    </Modal>
  );
}

function EscrowDetailModal({ orgId, escrowId, onClose, onChanged }) {
  const [e, setE] = useState(null);
  const [error, setError] = useState("");
  const [acting, setActing] = useState("");
  const [disputeReason, setDisputeReason] = useState({});

  const load = useCallback(async () => {
    try {
      setE(await api(`/api/orgs/escrow/${escrowId}?orgId=${orgId}`));
    } catch (err) { setError(err.message); }
  }, [orgId, escrowId]);

  useEffect(() => { load(); }, [load]);

  async function handleTransition(action) {
    setActing(action); setError("");
    try {
      await api(`/api/orgs/escrow/${escrowId}/transition`, { method: "POST", body: JSON.stringify({ orgId, action }) });
      await load(); onChanged();
    } catch (err) { setError(err.message); } finally { setActing(""); }
  }

  async function handleConfirm(index) {
    setActing(`confirm-${index}`); setError("");
    try {
      await api(`/api/orgs/escrow/${escrowId}/milestones/${index}/confirm`, { method: "POST", body: JSON.stringify({ orgId }) });
      await load(); onChanged();
    } catch (err) { setError(err.message); } finally { setActing(""); }
  }

  async function handleProposeRelease(index) {
    setActing(`release-${index}`); setError("");
    try {
      await api(`/api/orgs/escrow/${escrowId}/milestones/${index}/propose-release`, { method: "POST", body: JSON.stringify({ orgId }) });
      await load(); onChanged();
    } catch (err) { setError(err.message); } finally { setActing(""); }
  }

  async function handleDispute(index) {
    setActing(`dispute-${index}`); setError("");
    try {
      await api(`/api/orgs/escrow/${escrowId}/milestones/${index}/dispute`, { method: "POST", body: JSON.stringify({ orgId, reason: disputeReason[index] || "" }) });
      await load(); onChanged();
    } catch (err) { setError(err.message); } finally { setActing(""); }
  }

  if (!e) return <Modal title="Escrow" onClose={onClose}>{error ? <p className="text-red-400 text-xs">{error}</p> : <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>}</Modal>;

  return (
    <Modal title="Escrow" onClose={onClose} wide>
      <div className="space-y-4">
        <span className={`inline-block text-[11px] font-bold uppercase px-2 py-0.5 rounded-full border ${STATUS_STYLE[e.status] || STATUS_STYLE.DRAFT}`}>{e.status.replace(/_/g, " ")}</span>

        <div className="flex flex-wrap gap-1.5">
          {e.status === "DRAFT" && <button onClick={() => handleTransition("requestFunding")} disabled={!!acting} className="text-[11px] font-bold uppercase px-2.5 py-1.5 rounded-md bg-white/5 border border-white/10 text-[var(--inaya-text-primary)] disabled:opacity-40">Request funding</button>}
          {e.status === "AWAITING_FUNDING" && <button onClick={() => handleTransition("fund")} disabled={!!acting} className="text-[11px] font-bold uppercase px-2.5 py-1.5 rounded-md bg-white/5 border border-white/10 text-[var(--inaya-text-primary)] disabled:opacity-40">Mark funded</button>}
          {e.status === "FUNDED" && <button onClick={() => handleTransition("activate")} disabled={!!acting} className="text-[11px] font-bold uppercase px-2.5 py-1.5 rounded-md bg-emerald-400/10 text-emerald-400 border border-emerald-400/30 disabled:opacity-40">Activate</button>}
          {["DRAFT", "AWAITING_FUNDING", "FUNDED"].includes(e.status) && <button onClick={() => handleTransition("cancel")} disabled={!!acting} className="text-[11px] font-bold uppercase px-2.5 py-1.5 rounded-md bg-red-400/10 text-red-400 border border-red-400/30 disabled:opacity-40">Cancel</button>}
        </div>

        <div className="space-y-2">
          {e.milestones.map((m, i) => (
            <div key={i} className="bg-black/20 border border-white/5 rounded-lg p-3">
              <div className="flex items-center justify-between">
                <span className="text-[var(--inaya-text-primary)] text-sm">{m.description}</span>
                <span className="text-[var(--inaya-text-muted)] text-xs font-mono">{e.currency} {m.amount.toFixed(2)}</span>
              </div>
              <p className="text-[var(--inaya-text-muted)] text-[11px] mt-1">{m.status}</p>
              {m.status === "PENDING" && e.status === "ACTIVE" && (
                <button onClick={() => handleConfirm(i)} disabled={!!acting} className="mt-2 text-[11px] font-bold uppercase px-2 py-1 rounded-md bg-white/5 border border-white/10 text-[var(--inaya-text-primary)] disabled:opacity-40">{acting === `confirm-${i}` ? "…" : "Confirm delivery"}</button>
              )}
              {m.status === "CONFIRMED" && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  <button onClick={() => handleProposeRelease(i)} disabled={!!acting} className="text-[11px] font-bold uppercase px-2 py-1 rounded-md bg-[#00f2fe]/10 text-[#00f2fe] border border-[#00f2fe]/30 disabled:opacity-40">{acting === `release-${i}` ? "…" : "Propose release"}</button>
                  <input value={disputeReason[i] || ""} onChange={(ev) => setDisputeReason((prev) => ({ ...prev, [i]: ev.target.value }))} placeholder="Dispute reason" className="bg-black/45 border border-white/15 rounded-lg px-2 py-1 text-[11px] text-[var(--inaya-text-primary)] w-40" />
                  <button onClick={() => handleDispute(i)} disabled={!!acting} className="text-[11px] font-bold uppercase px-2 py-1 rounded-md bg-red-400/10 text-red-400 border border-red-400/30 disabled:opacity-40">Dispute</button>
                </div>
              )}
            </div>
          ))}
        </div>

        {e.disputes?.length > 0 && (
          <div className="border-t border-white/5 pt-3">
            <p className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)] mb-1.5">Disputes</p>
            {e.disputes.map((d, i) => (
              <p key={i} className="text-xs text-red-400">Milestone {d.milestoneIndex}: {d.reason} — {d.resolutionStatus}</p>
            ))}
          </div>
        )}

        <p className="text-[var(--inaya-text-muted)] text-[11px]">Releases are proposed here but approved separately in AI Action Requests, with a 36-hour delay before anything executes.</p>
        {error && <p className="text-red-400 text-xs">{error}</p>}
      </div>
    </Modal>
  );
}

function Modal({ title, onClose, children, wide }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className={`bg-[var(--inaya-surface)] border border-white/10 rounded-2xl p-5 w-full ${wide ? "max-w-lg" : "max-w-md"} max-h-[85vh] overflow-y-auto`}>
        <div className="flex items-center justify-between gap-3 mb-4">
          <h3 className="text-[var(--inaya-text-primary)] font-bold text-sm truncate">{title}</h3>
          <button onClick={onClose} className="text-[var(--inaya-text-muted)] hover:text-[var(--inaya-text-primary)] text-lg leading-none shrink-0">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
