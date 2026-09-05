"use client";

// src/components/business/HealthView.js
//
// Health OS tab of the Business Workspace (Healthcare & Legal Expansion
// SOW, Phase 2/4) — Patient registry + Patient 360, backed by
// /api/orgs/health/patients. Same self-contained-view pattern
// CRMView.js/TasksView.js established: its own api() helper, its own
// Modal, no dependency on business/page.js internals beyond
// {orgId, canManage, email}.
//
// Deliberately thin for this pass: registry + 360 only (the highest-value
// "does this actually work end to end" slice) — scheduling, billing,
// consent, and ROI each already have real backend logic
// (health-scheduling.js, health-billing.js, health-consent-workflow.js,
// health-roi-workflow.js) but no dedicated UI screen yet; a natural
// follow-up once this slice is confirmed working.

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../EmptyState";

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

const STATUS_STYLES = {
  active: "bg-emerald-400/10 text-emerald-400 border-emerald-400/30",
  merged: "bg-white/5 text-[var(--inaya-text-muted)] border-white/10",
};

export default function HealthView({ orgId, canManage, email }) {
  const [patients, setPatients] = useState(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [selected, setSelected] = useState(null);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ orgId });
      if (search) params.set("search", search);
      const data = await api(`/api/orgs/health/patients?${params.toString()}`);
      setPatients(data.patients);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId, search]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search patients…" className="bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab] w-56" />
        <button onClick={() => setShowCreate(true)} className="ml-auto text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg">+ New patient</button>
      </div>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!patients ? (
          <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>
        ) : patients.length === 0 ? (
          <EmptyState compact icon="🩺" description="No patients match, or you have no care-team assignments yet." ctaLabel="Register a patient" onCta={() => setShowCreate(true)} />
        ) : (
          <div className="space-y-2">
            {patients.map((p) => (
              <button key={p.id} onClick={() => setSelected(p)} className="w-full flex items-center justify-between gap-3 bg-black/20 border border-white/5 rounded-lg p-3 text-left hover:bg-white/5">
                <div className="min-w-0">
                  <span className="text-[var(--inaya-text-primary)] text-sm">{p.preferredName || p.legalName}</span>
                  <p className="text-[var(--inaya-text-muted)] text-[12px] font-mono mt-0.5 truncate">{p.facility || "No facility"} · DOB {p.dateOfBirth}</p>
                </div>
                <span className={`text-[11px] font-bold uppercase px-2 py-0.5 rounded-full border shrink-0 ${STATUS_STYLES[p.status] || STATUS_STYLES.active}`}>{p.status}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {showCreate && <CreatePatientModal orgId={orgId} onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load(); }} />}
      {selected && <Patient360Modal orgId={orgId} patientId={selected.id} onClose={() => setSelected(null)} />}
    </div>
  );
}

function CreatePatientModal({ orgId, onClose, onCreated }) {
  const [legalName, setLegalName] = useState("");
  const [preferredName, setPreferredName] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [facility, setFacility] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e) {
    e.preventDefault();
    if (!legalName.trim() || !dateOfBirth) return;
    setSubmitting(true);
    setError("");
    try {
      await api("/api/orgs/health/patients", { method: "POST", body: JSON.stringify({ orgId, legalName: legalName.trim(), preferredName: preferredName.trim() || undefined, dateOfBirth, facility: facility.trim() || undefined }) });
      onCreated();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Register patient" onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-3">
        <input value={legalName} onChange={(e) => setLegalName(e.target.value)} required placeholder="Legal name" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input value={preferredName} onChange={(e) => setPreferredName(e.target.value)} placeholder="Preferred name (optional)" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input value={dateOfBirth} onChange={(e) => setDateOfBirth(e.target.value)} type="date" required className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)]" />
        <input value={facility} onChange={(e) => setFacility(e.target.value)} placeholder="Facility (optional)" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        {error && <p className="text-red-400 text-xs">{error}</p>}
        <button disabled={submitting || !legalName.trim() || !dateOfBirth} className="w-full py-2.5 rounded-xl text-xs font-bold uppercase tracking-wide bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40">{submitting ? "Registering…" : "Register patient"}</button>
      </form>
    </Modal>
  );
}

function Patient360Modal({ orgId, patientId, onClose }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api(`/api/orgs/health/patients/${patientId}?orgId=${orgId}`).then(setDetail).catch((err) => setError(err.message));
  }, [orgId, patientId]);

  if (error) return <Modal title="Patient" onClose={onClose}><p className="text-red-400 text-xs">{error}</p></Modal>;
  if (!detail) return <Modal title="Patient" onClose={onClose}><p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p></Modal>;

  return (
    <Modal title={detail.patient.preferredName || detail.patient.legalName} onClose={onClose}>
      <div className="space-y-4 text-sm">
        <p className="text-[12px] font-mono text-[var(--inaya-text-muted)]">{detail.patient.facility || "No facility"} · DOB {detail.patient.dateOfBirth} · consent: {detail.patient.consentStatus}</p>

        <Section title={`Encounters (${detail.encounters.length})`}>
          {detail.encounters.length === 0 ? <Empty /> : detail.encounters.map((e) => <Row key={e.id} left={e.reason || "Encounter"} right={e.date} />)}
        </Section>
        <Section title={`Clinical records (${detail.clinicalRecords.length})`}>
          {detail.clinicalRecords.length === 0 ? <Empty /> : detail.clinicalRecords.map((r) => <Row key={r.id} left={r.template} right={r.status} />)}
        </Section>
        <Section title={`Upcoming appointments (${detail.appointments.length})`}>
          {detail.appointments.length === 0 ? <Empty /> : detail.appointments.map((a) => <Row key={a.id} left={a.type} right={a.startAt?.slice(0, 10)} />)}
        </Section>
        <Section title={`Consents (${detail.consents.length})`}>
          {detail.consents.length === 0 ? <Empty /> : detail.consents.map((c) => <Row key={c.id} left={`${c.type} — ${c.purpose}`} right={c.status} />)}
        </Section>
        <Section title="Recent access">
          {detail.recentAccess.length === 0 ? <Empty /> : detail.recentAccess.slice(0, 5).map((a, i) => <Row key={i} left={a.actorEmail} right={a.action} />)}
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
