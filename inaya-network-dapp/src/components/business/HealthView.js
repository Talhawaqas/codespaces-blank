"use client";

// src/components/business/HealthView.js
//
// Health OS tab of the Business Workspace (Healthcare & Legal Expansion
// SOW) — Patient registry + Patient 360 (with real actions for consent,
// ROI, appointments, billing, and care-team assignment), Emergency
// Access Review, and Research Datasets. Same self-contained-view pattern
// CRMView.js/TasksView.js established: its own api() helper, its own
// Modal, no dependency on business/page.js internals beyond
// {orgId, canManage, email}.

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
  const [tab, setTab] = useState("patients"); // 'patients' | 'emergencyAccess' | 'research'

  return (
    <div className="space-y-5">
      <div className="flex bg-[var(--inaya-surface)] border border-white/5 rounded-xl p-1 w-fit flex-wrap">
        <button onClick={() => setTab("patients")} className={`px-4 py-2 text-xs font-bold uppercase rounded-lg ${tab === "patients" ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>Patients</button>
        <button onClick={() => setTab("emergencyAccess")} className={`px-4 py-2 text-xs font-bold uppercase rounded-lg ${tab === "emergencyAccess" ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>Emergency Access</button>
        <button onClick={() => setTab("research")} className={`px-4 py-2 text-xs font-bold uppercase rounded-lg ${tab === "research" ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>Research Datasets</button>
      </div>
      {tab === "patients" && <PatientsTab orgId={orgId} email={email} />}
      {tab === "emergencyAccess" && <EmergencyAccessTab orgId={orgId} canManage={canManage} />}
      {tab === "research" && <ResearchTab orgId={orgId} canManage={canManage} />}
    </div>
  );
}

// ============================================================
// PATIENTS + PATIENT 360
// ============================================================
function PatientsTab({ orgId, email }) {
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
      {selected && <Patient360Modal orgId={orgId} email={email} patientId={selected.id} onClose={() => setSelected(null)} />}
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

function Patient360Modal({ orgId, email, patientId, onClose }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null); // {message, notFound}
  const [requestingAccess, setRequestingAccess] = useState(false);

  const load = useCallback(() => {
    setError(null);
    api(`/api/orgs/health/patients/${patientId}?orgId=${orgId}`).then(setDetail).catch((err) => setError({ message: err.message, notFound: /not found/i.test(err.message) }));
  }, [orgId, patientId]);

  useEffect(() => { load(); }, [load]);

  async function requestEmergencyAccess() {
    const reason = window.prompt("Reason for emergency access (required, will be audited and reviewed by a manager):");
    if (!reason || !reason.trim()) return;
    setRequestingAccess(true);
    try {
      await api("/api/orgs/health/breakglass", { method: "POST", body: JSON.stringify({ orgId, patientId, reason: reason.trim() }) });
      load();
    } catch (err) {
      setError({ message: err.message });
    } finally {
      setRequestingAccess(false);
    }
  }

  if (error) {
    return (
      <Modal title="Patient" onClose={onClose}>
        <p className="text-red-400 text-xs mb-3">{error.message}</p>
        {error.notFound && (
          <button onClick={requestEmergencyAccess} disabled={requestingAccess} className="w-full py-2.5 rounded-xl text-xs font-bold uppercase tracking-wide bg-amber-400/15 text-amber-300 border border-amber-400/30 disabled:opacity-40">
            {requestingAccess ? "Requesting…" : "🚨 Request emergency access"}
          </button>
        )}
      </Modal>
    );
  }
  if (!detail) return <Modal title="Patient" onClose={onClose}><p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p></Modal>;

  return (
    <Modal title={detail.patient.preferredName || detail.patient.legalName} onClose={onClose} wide>
      <div className="space-y-4 text-sm">
        <p className="text-[12px] font-mono text-[var(--inaya-text-muted)]">{detail.patient.facility || "No facility"} · DOB {detail.patient.dateOfBirth} · consent: {detail.patient.consentStatus}</p>

        <Section title={`Encounters (${detail.encounters.length})`}>
          {detail.encounters.length === 0 ? <Empty /> : detail.encounters.map((e) => <Row key={e.id} left={e.reason || "Encounter"} right={e.date} />)}
        </Section>
        <Section title={`Clinical records (${detail.clinicalRecords.length})`}>
          {detail.clinicalRecords.length === 0 ? <Empty /> : detail.clinicalRecords.map((r) => <Row key={r.id} left={r.template} right={r.status} />)}
        </Section>

        <AppointmentsSection orgId={orgId} patientId={patientId} appointments={detail.appointments} onChanged={load} />
        <ConsentSection orgId={orgId} patientId={patientId} consents={detail.consents} onChanged={load} />
        <RoiSection orgId={orgId} patientId={patientId} />
        <BillingSection orgId={orgId} patientId={patientId} />
        <CareTeamSection orgId={orgId} patientId={patientId} />

        <Section title="Recent access">
          {detail.recentAccess.length === 0 ? <Empty /> : detail.recentAccess.slice(0, 5).map((a, i) => <Row key={i} left={a.actorEmail} right={a.action} />)}
        </Section>
      </div>
    </Modal>
  );
}

function AppointmentsSection({ orgId, patientId, appointments, onChanged }) {
  const [showForm, setShowForm] = useState(false);
  const [type, setType] = useState("");
  const [startAt, setStartAt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function handleCreate(e) {
    e.preventDefault();
    if (!type.trim() || !startAt) return;
    setSubmitting(true);
    setError("");
    try {
      await api("/api/orgs/health/appointments", { method: "POST", body: JSON.stringify({ orgId, patientId, type: type.trim(), startAt: new Date(startAt).toISOString() }) });
      setShowForm(false); setType(""); setStartAt("");
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function updateStatus(appointmentId, status) {
    try {
      await api("/api/orgs/health/appointments", { method: "PATCH", body: JSON.stringify({ orgId, appointmentId, status }) });
      onChanged();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <Section title={`Appointments (${appointments.length})`} onAdd={() => setShowForm((v) => !v)}>
      {showForm && (
        <form onSubmit={handleCreate} className="flex flex-wrap gap-2 mb-2 bg-black/20 border border-white/5 rounded-lg p-2.5">
          <input value={type} onChange={(e) => setType(e.target.value)} placeholder="Type (e.g. checkup)" className="flex-1 min-w-[120px] bg-black/45 border border-white/15 rounded-lg px-2.5 py-1.5 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
          <input value={startAt} onChange={(e) => setStartAt(e.target.value)} type="datetime-local" required className="bg-black/45 border border-white/15 rounded-lg px-2.5 py-1.5 text-xs text-[var(--inaya-text-primary)]" />
          <button disabled={submitting} className="text-[11px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3 py-1.5 rounded-lg disabled:opacity-40">Schedule</button>
        </form>
      )}
      {error && <p className="text-red-400 text-[11px] mb-1">{error}</p>}
      {appointments.length === 0 ? <Empty /> : appointments.map((a) => (
        <div key={a.id} className="flex items-center justify-between bg-black/20 border border-white/5 rounded-lg px-3 py-1.5 gap-2">
          <span className="text-[var(--inaya-text-primary)] text-xs truncate">{a.type} · {a.startAt?.slice(0, 16).replace("T", " ")}</span>
          <select value={a.status} onChange={(e) => updateStatus(a.id, e.target.value)} className="text-[10px] font-bold uppercase bg-black/40 border border-white/15 rounded px-1.5 py-0.5 text-[var(--inaya-text-primary)] shrink-0">
            {["SCHEDULED", "CONFIRMED", "CANCELLED", "COMPLETED", "NO_SHOW"].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      ))}
    </Section>
  );
}

function ConsentSection({ orgId, patientId, consents, onChanged }) {
  const [showForm, setShowForm] = useState(false);
  const [type, setType] = useState("");
  const [purpose, setPurpose] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function handleCreate(e) {
    e.preventDefault();
    if (!type.trim() || !purpose.trim()) return;
    setSubmitting(true);
    setError("");
    try {
      await api("/api/orgs/health/consents", { method: "POST", body: JSON.stringify({ orgId, patientId, type: type.trim(), purpose: purpose.trim() }) });
      setShowForm(false); setType(""); setPurpose("");
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function withdraw(consentId) {
    try {
      await api("/api/orgs/health/consents", { method: "PATCH", body: JSON.stringify({ orgId, consentId }) });
      onChanged();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <Section title={`Consents (${consents.length})`} onAdd={() => setShowForm((v) => !v)}>
      {showForm && (
        <form onSubmit={handleCreate} className="flex flex-wrap gap-2 mb-2 bg-black/20 border border-white/5 rounded-lg p-2.5">
          <input value={type} onChange={(e) => setType(e.target.value)} placeholder="Type (e.g. treatment)" className="flex-1 min-w-[100px] bg-black/45 border border-white/15 rounded-lg px-2.5 py-1.5 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
          <input value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="Purpose" className="flex-1 min-w-[100px] bg-black/45 border border-white/15 rounded-lg px-2.5 py-1.5 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
          <button disabled={submitting} className="text-[11px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3 py-1.5 rounded-lg disabled:opacity-40">Record</button>
        </form>
      )}
      {error && <p className="text-red-400 text-[11px] mb-1">{error}</p>}
      {consents.length === 0 ? <Empty /> : consents.map((c) => (
        <div key={c.id} className="flex items-center justify-between bg-black/20 border border-white/5 rounded-lg px-3 py-1.5 gap-2">
          <span className="text-[var(--inaya-text-primary)] text-xs truncate">{c.type} — {c.purpose}</span>
          {c.status === "ACTIVE" ? (
            <button onClick={() => withdraw(c.id)} className="text-[10px] font-bold uppercase text-red-400 shrink-0">Withdraw</button>
          ) : (
            <span className="text-[10px] font-mono text-[var(--inaya-text-muted)] shrink-0">{c.status}</span>
          )}
        </div>
      ))}
    </Section>
  );
}

function RoiSection({ orgId, patientId }) {
  const [requests, setRequests] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [purpose, setPurpose] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await api(`/api/orgs/health/roi?orgId=${orgId}&patientId=${patientId}`);
      setRequests(data.requests);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId, patientId]);

  useEffect(() => { load(); }, [load]);

  async function handleCreate(e) {
    e.preventDefault();
    if (!purpose.trim()) return;
    setSubmitting(true);
    setError("");
    try {
      await api("/api/orgs/health/roi", { method: "POST", body: JSON.stringify({ orgId, patientId, purpose: purpose.trim(), recipient: { name: recipientName.trim() || undefined }, requestedRecordIds: [] }) });
      setShowForm(false); setPurpose(""); setRecipientName("");
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function decide(roiRequestId, action) {
    try {
      await api("/api/orgs/health/roi", { method: "PATCH", body: JSON.stringify({ orgId, roiRequestId, action }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <Section title={`Release of information (${requests?.length ?? "…"})`} onAdd={() => setShowForm((v) => !v)}>
      {showForm && (
        <form onSubmit={handleCreate} className="flex flex-wrap gap-2 mb-2 bg-black/20 border border-white/5 rounded-lg p-2.5">
          <input value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="Purpose (e.g. insurance claim)" className="flex-1 min-w-[120px] bg-black/45 border border-white/15 rounded-lg px-2.5 py-1.5 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
          <input value={recipientName} onChange={(e) => setRecipientName(e.target.value)} placeholder="Recipient (optional)" className="flex-1 min-w-[100px] bg-black/45 border border-white/15 rounded-lg px-2.5 py-1.5 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
          <button disabled={submitting} className="text-[11px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3 py-1.5 rounded-lg disabled:opacity-40">Request</button>
        </form>
      )}
      {error && <p className="text-red-400 text-[11px] mb-1">{error}</p>}
      {!requests || requests.length === 0 ? <Empty /> : requests.map((r) => (
        <div key={r.id} className="flex items-center justify-between bg-black/20 border border-white/5 rounded-lg px-3 py-1.5 gap-2">
          <span className="text-[var(--inaya-text-primary)] text-xs truncate">{r.purpose}</span>
          <div className="flex items-center gap-1.5 shrink-0">
            {r.status === "REQUESTED" && <button onClick={() => decide(r.id, "authorize")} className="text-[10px] font-bold uppercase text-[#00f2fe]">Authorize</button>}
            {r.status === "AUTHORIZED" && (
              <>
                <button onClick={() => decide(r.id, "approve")} className="text-[10px] font-bold uppercase text-emerald-400">Approve</button>
                <button onClick={() => decide(r.id, "reject")} className="text-[10px] font-bold uppercase text-red-400">Reject</button>
              </>
            )}
            {["APPROVED", "REJECTED"].includes(r.status) && <span className="text-[10px] font-mono text-[var(--inaya-text-muted)]">{r.status}</span>}
          </div>
        </div>
      ))}
    </Section>
  );
}

function BillingSection({ orgId, patientId }) {
  const [invoices, setInvoices] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await api(`/api/orgs/health/billing?orgId=${orgId}&patientId=${patientId}`);
      setInvoices(data.invoices);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId, patientId]);

  useEffect(() => { load(); }, [load]);

  async function handleCreate(e) {
    e.preventDefault();
    const amountNum = parseFloat(amount);
    if (!description.trim() || !amountNum) return;
    setSubmitting(true);
    setError("");
    try {
      await api("/api/orgs/health/billing", { method: "POST", body: JSON.stringify({ orgId, patientId, lineItems: [{ amount: amountNum, quantity: 1, description: description.trim() }] }) });
      setShowForm(false); setDescription(""); setAmount("");
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Section title={`Billing (${invoices?.length ?? "…"})`} onAdd={() => setShowForm((v) => !v)}>
      {showForm && (
        <form onSubmit={handleCreate} className="flex flex-wrap gap-2 mb-2 bg-black/20 border border-white/5 rounded-lg p-2.5">
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Line item description" className="flex-1 min-w-[120px] bg-black/45 border border-white/15 rounded-lg px-2.5 py-1.5 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
          <input value={amount} onChange={(e) => setAmount(e.target.value)} type="number" step="0.01" placeholder="Amount" className="w-24 bg-black/45 border border-white/15 rounded-lg px-2.5 py-1.5 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
          <button disabled={submitting} className="text-[11px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3 py-1.5 rounded-lg disabled:opacity-40">Create invoice</button>
        </form>
      )}
      {error && <p className="text-red-400 text-[11px] mb-1">{error}</p>}
      {!invoices || invoices.length === 0 ? <Empty /> : invoices.map((inv) => <Row key={inv.id} left={inv.invoiceNumber} right={`$${inv.total} · ${inv.status}`} />)}
    </Section>
  );
}

function CareTeamSection({ orgId, patientId }) {
  const [showForm, setShowForm] = useState(false);
  const [memberEmail, setMemberEmail] = useState("");
  const [role, setRole] = useState("member");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [assigned, setAssigned] = useState(false);

  async function handleAssign(e) {
    e.preventDefault();
    if (!memberEmail.trim()) return;
    setSubmitting(true);
    setError("");
    try {
      await api("/api/orgs/health/care-team", { method: "POST", body: JSON.stringify({ orgId, patientId, memberEmail: memberEmail.trim(), role }) });
      setMemberEmail(""); setAssigned(true);
      setTimeout(() => setAssigned(false), 3000);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Section title="Care team" onAdd={() => setShowForm((v) => !v)}>
      {showForm && (
        <form onSubmit={handleAssign} className="flex flex-wrap gap-2 mb-2 bg-black/20 border border-white/5 rounded-lg p-2.5">
          <input value={memberEmail} onChange={(e) => setMemberEmail(e.target.value)} type="email" placeholder="Member email" className="flex-1 min-w-[140px] bg-black/45 border border-white/15 rounded-lg px-2.5 py-1.5 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
          <select value={role} onChange={(e) => setRole(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-2.5 py-1.5 text-xs text-[var(--inaya-text-primary)]">
            <option value="member">Member</option>
            <option value="physician">Physician</option>
            <option value="nurse">Nurse</option>
          </select>
          <button disabled={submitting} className="text-[11px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3 py-1.5 rounded-lg disabled:opacity-40">Assign</button>
        </form>
      )}
      {error && <p className="text-red-400 text-[11px] mb-1">{error}</p>}
      {assigned && <p className="text-emerald-400 text-[11px]">Assigned — they now have access to this patient.</p>}
    </Section>
  );
}

// ============================================================
// EMERGENCY ACCESS REVIEW (managers)
// ============================================================
function EmergencyAccessTab({ orgId, canManage }) {
  const [grants, setGrants] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await api(`/api/orgs/health/breakglass?orgId=${orgId}`);
      setGrants(data.grants);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  async function review(assignmentId) {
    const reviewNotes = window.prompt("Review notes (optional):") || "";
    try {
      await api("/api/orgs/health/breakglass", { method: "PATCH", body: JSON.stringify({ orgId, assignmentId, reviewNotes }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  if (!canManage) return <p className="text-[var(--inaya-text-muted)] text-sm">Only a health manager or org owner/admin can review emergency access grants.</p>;

  return (
    <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
      {error && <p className="text-red-400 text-xs mb-3">{error}</p>}
      {!grants ? (
        <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>
      ) : grants.length === 0 ? (
        <EmptyState compact icon="✅" description="No unreviewed emergency access grants." />
      ) : (
        <div className="space-y-2">
          {grants.map((g) => (
            <div key={g.id} className="bg-black/20 border border-amber-400/20 rounded-lg p-3">
              <p className="text-[var(--inaya-text-primary)] text-sm">{g.email}</p>
              <p className="text-[var(--inaya-text-muted)] text-xs mt-0.5">{g.reason}</p>
              <p className="text-[var(--inaya-text-muted)] text-[11px] font-mono mt-0.5">Expires {g.expiresAt?.slice(0, 16).replace("T", " ")}</p>
              <button onClick={() => review(g.id)} className="mt-2 text-[11px] font-bold uppercase text-[#00f2fe]">Mark reviewed</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================
// RESEARCH DATASETS (managers)
// ============================================================
function ResearchTab({ orgId, canManage }) {
  const [name, setName] = useState("");
  const [methodology, setMethodology] = useState("");
  const [patientIds, setPatientIds] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState(null);

  async function handleCreate(e) {
    e.preventDefault();
    if (!name.trim() || !methodology.trim()) return;
    setSubmitting(true);
    setError("");
    setCreated(null);
    try {
      const ids = patientIds.split(",").map((s) => s.trim()).filter(Boolean);
      const data = await api("/api/orgs/health/research", { method: "POST", body: JSON.stringify({ orgId, name: name.trim(), methodologyNotes: methodology.trim(), sourcePatientIds: ids }) });
      setCreated(data.dataset);
      setName(""); setMethodology(""); setPatientIds("");
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  if (!canManage) return <p className="text-[var(--inaya-text-muted)] text-sm">Only a health manager or org owner/admin can create research datasets.</p>;

  return (
    <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5 space-y-3 max-w-lg">
      <p className="text-[var(--inaya-text-muted)] text-xs">De-identified research datasets require a documented methodology — there's no "anonymous" checkbox, you describe exactly what was done to the data.</p>
      <form onSubmit={handleCreate} className="space-y-2.5">
        <input value={name} onChange={(e) => setName(e.target.value)} required placeholder="Dataset name" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <textarea value={methodology} onChange={(e) => setMethodology(e.target.value)} required placeholder="De-identification methodology (required — describe what fields were stripped/generalized and how)" rows={3} className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input value={patientIds} onChange={(e) => setPatientIds(e.target.value)} placeholder="Source patient IDs, comma-separated" className="w-full bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        {error && <p className="text-red-400 text-xs">{error}</p>}
        <button disabled={submitting || !name.trim() || !methodology.trim()} className="w-full py-2.5 rounded-xl text-xs font-bold uppercase tracking-wide bg-gradient-to-r from-[#00f2fe] to-[#4facfe] text-black disabled:opacity-40">{submitting ? "Creating…" : "Create dataset"}</button>
      </form>
      {created && <p className="text-emerald-400 text-xs">Created "{created.name}" v{created.version} from {created.sourceRecordCount} source record(s).</p>}
    </div>
  );
}

// ============================================================
// SHARED PRIMITIVES
// ============================================================
function Section({ title, children, onAdd }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <p className="text-[11px] font-bold uppercase tracking-wide text-[var(--inaya-text-muted)]">{title}</p>
        {onAdd && <button onClick={onAdd} className="text-[11px] font-bold uppercase text-[#00f2fe]">+ Add</button>}
      </div>
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

function Modal({ title, onClose, children, wide }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className={`bg-[var(--inaya-surface)] border border-white/10 rounded-2xl p-5 w-full ${wide ? "max-w-xl" : "max-w-md"} max-h-[85vh] overflow-y-auto`}>
        <div className="flex items-center justify-between gap-3 mb-4">
          <h3 className="text-[var(--inaya-text-primary)] font-bold text-sm truncate">{title}</h3>
          <button onClick={onClose} className="text-[var(--inaya-text-muted)] hover:text-[var(--inaya-text-primary)] text-lg leading-none shrink-0">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
