"use client";

// src/components/business/LegalView.js
//
// Legal OS tab of the Business Workspace (Healthcare & Legal Expansion
// SOW, Phase 6/8) — Matters + Matter Workspace, backed by
// /api/orgs/legal/matters. Same self-contained-view pattern as
// HealthView.js/CRMView.js.
//
// Deliberately thin for this pass: matters + workspace only — clients,
// evidence, holds, discovery, billing, contracts, and trust accounting
// each already have real backend logic but no dedicated UI screen yet;
// a natural follow-up once this slice is confirmed working.

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../EmptyState";

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

const STATUS_STYLES = {
  OPEN: "bg-white/5 text-[var(--inaya-text-muted)] border-white/10",
  ACTIVE: "bg-[#00f2fe]/10 text-[#00f2fe] border-[#00f2fe]/30",
  ON_HOLD: "bg-amber-400/10 text-amber-400 border-amber-400/30",
  CLOSED: "bg-emerald-400/10 text-emerald-400 border-emerald-400/30",
};

export default function LegalView({ orgId, canManage, email }) {
  const [matters, setMatters] = useState(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [selected, setSelected] = useState(null);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ orgId });
      if (search) params.set("search", search);
      const data = await api(`/api/orgs/legal/matters?${params.toString()}`);
      setMatters(data.matters);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId, search]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search matters…" className="bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab] w-56" />
        <button onClick={() => setShowCreate(true)} className="ml-auto text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg">+ New matter</button>
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!matters ? (
          <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>
        ) : matters.length === 0 ? (
          <EmptyState compact icon="⚖️" description="No matters match, or you have no matter-team assignments yet." ctaLabel="Open a matter" onCta={() => setShowCreate(true)} />
        ) : (
          <div className="space-y-2">
            {matters.map((m) => (
              <button key={m.id} onClick={() => setSelected(m)} className="w-full flex items-center justify-between gap-3 bg-black/20 border border-white/5 rounded-lg p-3 text-left hover:bg-white/5">
                <div className="min-w-0">
                  <span className="text-[var(--inaya-text-primary)] text-sm">{m.name}</span>
                  <p className="text-[var(--inaya-text-muted)] text-[12px] font-mono mt-0.5 truncate">{m.type}{m.jurisdiction ? ` · ${m.jurisdiction}` : ""}</p>
                </div>
                <span className={`text-[11px] font-bold uppercase px-2 py-0.5 rounded-full border shrink-0 ${STATUS_STYLES[m.status] || STATUS_STYLES.OPEN}`}>{m.status}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {showCreate && <CreateMatterModal orgId={orgId} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load(); }} />}
      {selected && <MatterWorkspaceModal orgId={orgId} matterId={selected.id} onClose={() => setSelected(null)} />}
    </div>
  );
}

function CreateMatterModal({ orgId, onClose, onCreated }) {
  const [name, setName] = useState("");
  const [type, setType] = useState("litigation");
  const [jurisdiction, setJurisdiction] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    if (!name.trim()) return;
    setSubmitting(true);
    setError("");
    try {
      await api("/api/orgs/legal/matters", { method: "POST", body: JSON.stringify({ orgId, name: name.trim(), type, jurisdiction: jurisdiction.trim() || undefined }) });
      onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Open matter" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-3">
        <input value={name} onChange={(e) => setName(e.target.value)} required placeholder="Matter name" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <select value={type} onChange={(e) => setType(e.target.value)} className="w-full bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
          <option value="litigation">Litigation</option>
          <option value="corporate">Corporate</option>
          <option value="regulatory">Regulatory</option>
          <option value="advisory">Advisory</option>
        </select>
        <input value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value)} placeholder="Jurisdiction (optional)" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        {error && <p className="text-red-400 text-xs">{error}</p>}
        <button disabled={submitting || !name.trim()} className="w-full py-2.5 rounded-xl text-xs font-bold uppercase tracking-wide bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40">{submitting ? "Opening…" : "Open matter"}</button>
      </form>
    </Modal>
  );
}

function MatterWorkspaceModal({ orgId, matterId, onClose }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api(`/api/orgs/legal/matters/${matterId}?orgId=${orgId}`).then(setDetail).catch((err) => setError(err.message));
  }, [orgId, matterId]);

  if (error) return <Modal title="Matter" onClose={onClose}><p className="text-red-400 text-xs">{error}</p></Modal>;
  if (!detail) return <Modal title="Matter" onClose={onClose}><p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p></Modal>;

  return (
    <Modal title={detail.matter.name} onClose={onClose}>
      <div className="space-y-4 text-sm">
        <p className="text-[12px] font-mono text-[var(--inaya-text-muted)]">{detail.matter.type}{detail.matter.jurisdiction ? ` · ${detail.matter.jurisdiction}` : ""} · {detail.matter.responsiblePartnerEmail}</p>

        <Section title={`Team (${detail.team.length})`}>
          {detail.team.length === 0 ? <Empty /> : detail.team.map((t, i) => <Row key={i} left={t.email} right={t.role} />)}
        </Section>
        <Section title={`Deadlines (${detail.deadlines.length})`}>
          {detail.deadlines.length === 0 ? <Empty /> : detail.deadlines.map((d) => (
            <Row key={d.id} left={d.description} right={`${d.dueAt?.slice(0, 10)}${!d.manualConfirmation ? " (unconfirmed)" : ""}`} />
          ))}
        </Section>
        <Section title={`Evidence (${detail.evidence.length})`}>
          {detail.evidence.length === 0 ? <Empty /> : detail.evidence.map((e) => <Row key={e.id} left={e.source} right={e.custodian} />)}
        </Section>
      </div>
    </Modal>
  );
}

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
