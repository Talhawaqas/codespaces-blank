"use client";

// src/components/business/LegalView.js
//
// Legal OS tab of the Business Workspace (Healthcare & Legal Expansion
// SOW) — Matters (with a full Matter Workspace: team, deadlines,
// evidence, holds, discovery, redaction, contracts, time & billing,
// trust accounting), Clients, Prospects, and Corporate Entities. Same
// self-contained-view pattern as HealthView.js/CRMView.js.

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
  const [tab, setTab] = useState("matters"); // 'matters' | 'clients' | 'prospects' | 'entities'

  return (
    <div className="space-y-5">
      <div className="flex bg-[var(--inaya-surface)] border border-white/5 rounded-xl p-1 w-fit flex-wrap">
        <button onClick={() => setTab("matters")} className={`px-4 py-2 text-xs font-bold uppercase rounded-lg ${tab === "matters" ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>Matters</button>
        <button onClick={() => setTab("clients")} className={`px-4 py-2 text-xs font-bold uppercase rounded-lg ${tab === "clients" ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>Clients</button>
        <button onClick={() => setTab("prospects")} className={`px-4 py-2 text-xs font-bold uppercase rounded-lg ${tab === "prospects" ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>Prospects</button>
        <button onClick={() => setTab("entities")} className={`px-4 py-2 text-xs font-bold uppercase rounded-lg ${tab === "entities" ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>Entities</button>
      </div>
      {tab === "matters" && <MattersTab orgId={orgId} email={email} />}
      {tab === "clients" && <ClientsTab orgId={orgId} />}
      {tab === "prospects" && <ProspectsTab orgId={orgId} />}
      {tab === "entities" && <EntitiesTab orgId={orgId} />}
    </div>
  );
}

// ============================================================
// MATTERS + MATTER WORKSPACE
// ============================================================
function MattersTab({ orgId, email }) {
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
      {selected && <MatterWorkspaceModal orgId={orgId} email={email} matterId={selected.id} onClose={() => setSelected(null)} />}
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

function MatterWorkspaceModal({ orgId, email, matterId, onClose }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState("");
  const [section, setSection] = useState("overview");

  const load = useCallback(() => {
    api(`/api/orgs/legal/matters/${matterId}?orgId=${orgId}`).then(setDetail).catch((err) => setError(err.message));
  }, [orgId, matterId]);

  useEffect(() => { load(); }, [load]);

  if (error) return <Modal title="Matter" onClose={onClose}><p className="text-red-400 text-xs">{error}</p></Modal>;
  if (!detail) return <Modal title="Matter" onClose={onClose}><p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p></Modal>;

  const SECTIONS = ["overview", "team", "deadlines", "evidence", "holds", "discovery", "redaction", "contracts", "time & billing", "trust"];

  return (
    <Modal title={detail.matter.name} onClose={onClose} wide>
      <div className="flex gap-1 flex-wrap mb-3 border-b border-white/5 pb-2">
        {SECTIONS.map((s) => (
          <button key={s} onClick={() => setSection(s)} className={`text-[10px] font-bold uppercase px-2 py-1 rounded ${section === s ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)] hover:text-slate-200"}`}>{s}</button>
        ))}
      </div>

      {section === "overview" && (
        <div className="space-y-3 text-sm">
          <p className="text-[12px] font-mono text-[var(--inaya-text-muted)]">{detail.matter.type}{detail.matter.jurisdiction ? ` · ${detail.matter.jurisdiction}` : ""} · {detail.matter.responsiblePartnerEmail}</p>
          <MatterStatusControl orgId={orgId} matterId={matterId} status={detail.matter.status} onChanged={load} />
        </div>
      )}
      {section === "team" && <TeamSection orgId={orgId} matterId={matterId} team={detail.team} onChanged={load} />}
      {section === "deadlines" && <DeadlinesSection orgId={orgId} matterId={matterId} deadlines={detail.deadlines} onChanged={load} />}
      {section === "evidence" && <EvidenceSection orgId={orgId} matterId={matterId} evidence={detail.evidence} onChanged={load} />}
      {section === "holds" && <HoldsSection orgId={orgId} matterId={matterId} email={email} />}
      {section === "discovery" && <DiscoverySection orgId={orgId} matterId={matterId} />}
      {section === "redaction" && <RedactionSection orgId={orgId} matterId={matterId} />}
      {section === "contracts" && <ContractsSection orgId={orgId} matterId={matterId} />}
      {section === "time & billing" && <TimeBillingSection orgId={orgId} matterId={matterId} email={email} />}
      {section === "trust" && <TrustAccountingSection orgId={orgId} matterId={matterId} />}
    </Modal>
  );
}

function MatterStatusControl({ orgId, matterId, status, onChanged }) {
  const [error, setError] = useState("");
  const ACTIONS = { OPEN: [["activate", "Activate"]], ACTIVE: [["putOnHold", "Put on hold"], ["close", "Close"]], ON_HOLD: [["resume", "Resume"]], CLOSED: [] };
  async function act(action) {
    try {
      await api("/api/orgs/legal/matters", { method: "PATCH", body: JSON.stringify({ orgId, matterId, action }) });
      onChanged();
    } catch (err) {
      setError(err.message);
    }
  }
  return (
    <div>
      {error && <p className="text-red-400 text-xs mb-1">{error}</p>}
      <div className="flex gap-2">
        {(ACTIONS[status] || []).map(([action, label]) => (
          <button key={action} onClick={() => act(action)} className="text-[11px] font-bold uppercase px-3 py-1.5 rounded-md bg-white/5 border border-white/10 text-[var(--inaya-text-primary)] hover:bg-white/10">{label}</button>
        ))}
      </div>
    </div>
  );
}

function TeamSection({ orgId, matterId, team, onChanged }) {
  const [memberEmail, setMemberEmail] = useState("");
  const [role, setRole] = useState("associate");
  const [error, setError] = useState("");
  async function assign(e) {
    e.preventDefault();
    if (!memberEmail.trim()) return;
    try {
      await api("/api/orgs/legal/matter-team", { method: "POST", body: JSON.stringify({ orgId, matterId, memberEmail: memberEmail.trim(), role }) });
      setMemberEmail("");
      onChanged();
    } catch (err) {
      setError(err.message);
    }
  }
  return (
    <Section title={`Team (${team.length})`}>
      <form onSubmit={assign} className="flex flex-wrap gap-2 mb-2">
        <input value={memberEmail} onChange={(e) => setMemberEmail(e.target.value)} type="email" placeholder="Member email" className="flex-1 min-w-[140px] bg-black/45 border border-white/15 rounded-lg px-2.5 py-1.5 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <select value={role} onChange={(e) => setRole(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-2.5 py-1.5 text-xs text-[var(--inaya-text-primary)]">
          <option value="partner">Partner</option>
          <option value="associate">Associate</option>
          <option value="paralegal">Paralegal</option>
        </select>
        <button className="text-[11px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3 py-1.5 rounded-lg">Assign</button>
      </form>
      {error && <p className="text-red-400 text-[11px] mb-1">{error}</p>}
      {team.length === 0 ? <Empty /> : team.map((t, i) => <Row key={i} left={t.email} right={t.role} />)}
    </Section>
  );
}

function DeadlinesSection({ orgId, matterId, deadlines, onChanged }) {
  const [description, setDescription] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [error, setError] = useState("");
  async function create(e) {
    e.preventDefault();
    if (!description.trim() || !dueAt) return;
    try {
      await api("/api/orgs/legal/deadlines", { method: "POST", body: JSON.stringify({ orgId, matterId, description: description.trim(), dueAt: new Date(dueAt).toISOString(), source: "manual" }) });
      setDescription(""); setDueAt("");
      onChanged();
    } catch (err) {
      setError(err.message);
    }
  }
  async function confirm(deadlineId) {
    try {
      await api("/api/orgs/legal/deadlines", { method: "PATCH", body: JSON.stringify({ orgId, deadlineId }) });
      onChanged();
    } catch (err) {
      setError(err.message);
    }
  }
  return (
    <Section title={`Deadlines (${deadlines.length})`}>
      <form onSubmit={create} className="flex flex-wrap gap-2 mb-2">
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description" className="flex-1 min-w-[120px] bg-black/45 border border-white/15 rounded-lg px-2.5 py-1.5 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input value={dueAt} onChange={(e) => setDueAt(e.target.value)} type="datetime-local" className="bg-black/45 border border-white/15 rounded-lg px-2.5 py-1.5 text-xs text-[var(--inaya-text-primary)]" />
        <button className="text-[11px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3 py-1.5 rounded-lg">Add</button>
      </form>
      {error && <p className="text-red-400 text-[11px] mb-1">{error}</p>}
      {deadlines.length === 0 ? <Empty /> : deadlines.map((d) => (
        <div key={d.id} className="flex items-center justify-between bg-black/20 border border-white/5 rounded-lg px-3 py-1.5 gap-2">
          <span className="text-[var(--inaya-text-primary)] text-xs truncate">{d.description} · {d.dueAt?.slice(0, 10)}</span>
          {!d.manualConfirmation ? <button onClick={() => confirm(d.id)} className="text-[10px] font-bold uppercase text-amber-400 shrink-0">Unconfirmed — Confirm</button> : <span className="text-[10px] font-mono text-emerald-400 shrink-0">Confirmed</span>}
        </div>
      ))}
    </Section>
  );
}

function EvidenceSection({ orgId, matterId, evidence, onChanged }) {
  const [source, setSource] = useState("");
  const [error, setError] = useState("");
  async function acquire(e) {
    e.preventDefault();
    if (!source.trim()) return;
    try {
      await api("/api/orgs/legal/evidence", { method: "POST", body: JSON.stringify({ orgId, matterId, source: source.trim() }) });
      setSource("");
      onChanged();
    } catch (err) {
      setError(err.message);
    }
  }
  async function transfer(evidenceId) {
    const destination = window.prompt("Transfer custody to (name/location):");
    if (!destination) return;
    try {
      await api("/api/orgs/legal/evidence", { method: "PATCH", body: JSON.stringify({ orgId, evidenceId, destination, reason: "Reassigned via UI" }) });
      onChanged();
    } catch (err) {
      setError(err.message);
    }
  }
  return (
    <Section title={`Evidence (${evidence.length})`}>
      <form onSubmit={acquire} className="flex flex-wrap gap-2 mb-2">
        <input value={source} onChange={(e) => setSource(e.target.value)} placeholder="Source (e.g. seized laptop)" className="flex-1 min-w-[140px] bg-black/45 border border-white/15 rounded-lg px-2.5 py-1.5 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <button className="text-[11px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3 py-1.5 rounded-lg">Acquire</button>
      </form>
      {error && <p className="text-red-400 text-[11px] mb-1">{error}</p>}
      {evidence.length === 0 ? <Empty /> : evidence.map((e) => (
        <div key={e.id} className="flex items-center justify-between bg-black/20 border border-white/5 rounded-lg px-3 py-1.5 gap-2">
          <span className="text-[var(--inaya-text-primary)] text-xs truncate">{e.source} · custodian: {e.custodian}</span>
          <button onClick={() => transfer(e.id)} className="text-[10px] font-bold uppercase text-[#00f2fe] shrink-0">Transfer</button>
        </div>
      ))}
    </Section>
  );
}

function HoldsSection({ orgId, matterId, email }) {
  const [holds, setHolds] = useState(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await api(`/api/orgs/legal/holds?orgId=${orgId}`);
      setHolds(data.holds.filter((h) => h.matterId === matterId));
    } catch (err) {
      setError(err.message);
    }
  }, [orgId, matterId]);

  useEffect(() => { load(); }, [load]);

  async function create(e) {
    e.preventDefault();
    if (!reason.trim()) return;
    try {
      await api("/api/orgs/legal/holds", { method: "POST", body: JSON.stringify({ orgId, matterId, scope: "matter", custodianEmails: [email], reason: reason.trim() }) });
      setReason("");
      load();
    } catch (err) {
      setError(err.message);
    }
  }
  async function act(holdId, action) {
    try {
      await api("/api/orgs/legal/holds", { method: "PATCH", body: JSON.stringify({ orgId, holdId, action }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <Section title={`Legal holds (${holds?.length ?? "…"})`}>
      <p className="text-[11px] text-[var(--inaya-text-muted)] mb-2">A hold on this matter blocks deletion of related records until released.</p>
      <form onSubmit={create} className="flex flex-wrap gap-2 mb-2">
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason for hold" className="flex-1 min-w-[140px] bg-black/45 border border-white/15 rounded-lg px-2.5 py-1.5 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <button className="text-[11px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3 py-1.5 rounded-lg">Create hold</button>
      </form>
      {error && <p className="text-red-400 text-[11px] mb-1">{error}</p>}
      {!holds || holds.length === 0 ? <Empty /> : holds.map((h) => (
        <div key={h.id} className="flex items-center justify-between bg-black/20 border border-white/5 rounded-lg px-3 py-1.5 gap-2">
          <span className="text-[var(--inaya-text-primary)] text-xs truncate">{h.reason}</span>
          <div className="flex items-center gap-1.5 shrink-0">
            {h.status === "ACTIVE" ? (
              <>
                <button onClick={() => act(h.id, "acknowledge")} className="text-[10px] font-bold uppercase text-[#00f2fe]">Acknowledge</button>
                <button onClick={() => act(h.id, "release")} className="text-[10px] font-bold uppercase text-red-400">Release</button>
              </>
            ) : <span className="text-[10px] font-mono text-[var(--inaya-text-muted)]">{h.status}</span>}
          </div>
        </div>
      ))}
    </Section>
  );
}

function DiscoverySection({ orgId, matterId }) {
  const [requestingParty, setRequestingParty] = useState("");
  const [respondingParty, setRespondingParty] = useState("");
  const [created, setCreated] = useState(null);
  const [docIds, setDocIds] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  async function create(e) {
    e.preventDefault();
    if (!requestingParty.trim() || !respondingParty.trim()) return;
    try {
      const data = await api("/api/orgs/legal/discovery", { method: "POST", body: JSON.stringify({ orgId, matterId, requestingParty: requestingParty.trim(), respondingParty: respondingParty.trim() }) });
      setCreated(data.discovery);
      setStatus(data.discovery.status);
    } catch (err) {
      setError(err.message);
    }
  }
  async function addDocs() {
    const ids = docIds.split(",").map((s) => s.trim()).filter(Boolean);
    if (!ids.length) return;
    try {
      const data = await api("/api/orgs/legal/discovery", { method: "PATCH", body: JSON.stringify({ orgId, discoveryId: created.id, action: "addDocuments", documentIds: ids }) });
      setDocIds("");
      setStatus(`${data.added} document(s) added`);
    } catch (err) {
      setError(err.message);
    }
  }
  async function produce() {
    try {
      const data = await api("/api/orgs/legal/discovery", { method: "PATCH", body: JSON.stringify({ orgId, discoveryId: created.id, action: "produce" }) });
      setStatus(`Produced — ${data.discovery.productionCount} document(s) in production set`);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <Section title="Discovery">
      {!created ? (
        <form onSubmit={create} className="flex flex-wrap gap-2">
          <input value={requestingParty} onChange={(e) => setRequestingParty(e.target.value)} placeholder="Requesting party" className="flex-1 min-w-[120px] bg-black/45 border border-white/15 rounded-lg px-2.5 py-1.5 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
          <input value={respondingParty} onChange={(e) => setRespondingParty(e.target.value)} placeholder="Responding party" className="flex-1 min-w-[120px] bg-black/45 border border-white/15 rounded-lg px-2.5 py-1.5 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
          <button className="text-[11px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3 py-1.5 rounded-lg">Create request</button>
        </form>
      ) : (
        <div className="space-y-2">
          <p className="text-[var(--inaya-text-primary)] text-xs">{created.requestingParty} ↔ {created.respondingParty} — <span className="font-mono text-[var(--inaya-text-muted)]">{created.status}</span></p>
          <div className="flex flex-wrap gap-2">
            <input value={docIds} onChange={(e) => setDocIds(e.target.value)} placeholder="Document IDs, comma-separated" className="flex-1 min-w-[160px] bg-black/45 border border-white/15 rounded-lg px-2.5 py-1.5 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
            <button onClick={addDocs} className="text-[11px] font-bold uppercase text-[#00f2fe] px-3 py-1.5">Add documents</button>
          </div>
          <p className="text-[11px] text-[var(--inaya-text-muted)]">Document tagging (responsive/privileged) is done per-document via the API; the production step below automatically excludes anything tagged privileged even if responsive.</p>
          <button onClick={produce} className="text-[11px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3 py-1.5 rounded-lg">Produce</button>
          {status && <p className="text-emerald-400 text-[11px]">{status}</p>}
        </div>
      )}
      {error && <p className="text-red-400 text-[11px] mt-1">{error}</p>}
    </Section>
  );
}

function RedactionSection({ orgId, matterId }) {
  const [originalDocumentId, setOriginalDocumentId] = useState("");
  const [error, setError] = useState("");
  const [created, setCreated] = useState(null);
  async function create(e) {
    e.preventDefault();
    if (!originalDocumentId.trim()) return;
    try {
      const data = await api("/api/orgs/legal/redaction", { method: "POST", body: JSON.stringify({ orgId, matterId, originalDocumentId: originalDocumentId.trim() }) });
      setCreated(data.request);
      setOriginalDocumentId("");
    } catch (err) {
      setError(err.message);
    }
  }
  return (
    <Section title="Redaction">
      <p className="text-[11px] text-[var(--inaya-text-muted)] mb-2">Redacting a document never mutates the original — it produces a new, separately-linked redacted document.</p>
      <form onSubmit={create} className="flex flex-wrap gap-2">
        <input value={originalDocumentId} onChange={(e) => setOriginalDocumentId(e.target.value)} placeholder="Original document ID" className="flex-1 min-w-[140px] bg-black/45 border border-white/15 rounded-lg px-2.5 py-1.5 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <button className="text-[11px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3 py-1.5 rounded-lg">Request redaction</button>
      </form>
      {error && <p className="text-red-400 text-[11px] mt-1">{error}</p>}
      {created && <p className="text-emerald-400 text-[11px] mt-1">Redaction request {created.id} created — status {created.status}.</p>}
    </Section>
  );
}

function ContractsSection({ orgId, matterId }) {
  const [contracts, setContracts] = useState(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await api(`/api/orgs/legal/contracts?orgId=${orgId}&matterId=${matterId}`);
      setContracts(data.contracts);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId, matterId]);

  useEffect(() => { load(); }, [load]);

  async function create(e) {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      await api("/api/orgs/legal/contracts", { method: "POST", body: JSON.stringify({ orgId, matterId, name: name.trim() }) });
      setName("");
      load();
    } catch (err) {
      setError(err.message);
    }
  }
  const NEXT_ACTION = { INTAKE: "startDrafting", DRAFT: "submitForReview", REVIEW: "approve", APPROVED: "sendForNegotiation", NEGOTIATION: "sign" };
  async function advance(contractId, status) {
    const action = NEXT_ACTION[status];
    if (!action) return;
    try {
      await api("/api/orgs/legal/contracts", { method: "PATCH", body: JSON.stringify({ orgId, contractId, action }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <Section title={`Contracts (${contracts?.length ?? "…"})`}>
      <form onSubmit={create} className="flex flex-wrap gap-2 mb-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Contract name" className="flex-1 min-w-[140px] bg-black/45 border border-white/15 rounded-lg px-2.5 py-1.5 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <button className="text-[11px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3 py-1.5 rounded-lg">Create</button>
      </form>
      {error && <p className="text-red-400 text-[11px] mb-1">{error}</p>}
      {!contracts || contracts.length === 0 ? <Empty /> : contracts.map((c) => (
        <div key={c.id} className="flex items-center justify-between bg-black/20 border border-white/5 rounded-lg px-3 py-1.5 gap-2">
          <span className="text-[var(--inaya-text-primary)] text-xs truncate">{c.name}</span>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-[10px] font-mono text-[var(--inaya-text-muted)]">{c.status}</span>
            {NEXT_ACTION[c.status] && <button onClick={() => advance(c.id, c.status)} className="text-[10px] font-bold uppercase text-[#00f2fe]">Advance</button>}
          </div>
        </div>
      ))}
    </Section>
  );
}

function TimeBillingSection({ orgId, matterId, email }) {
  const [entries, setEntries] = useState(null);
  const [minutes, setMinutes] = useState("");
  const [rate, setRate] = useState("");
  const [taskDescription, setTaskDescription] = useState("");
  const [error, setError] = useState("");
  const [billResult, setBillResult] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await api(`/api/orgs/legal/time-entries?orgId=${orgId}&matterId=${matterId}`);
      setEntries(data.timeEntries);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId, matterId]);

  useEffect(() => { load(); }, [load]);

  async function logTime(e) {
    e.preventDefault();
    const min = parseInt(minutes, 10);
    if (!min || !taskDescription.trim()) return;
    try {
      await api("/api/orgs/legal/time-entries", { method: "POST", body: JSON.stringify({ orgId, matterId, minutes: min, rate: parseFloat(rate) || 0, taskDescription: taskDescription.trim() }) });
      setMinutes(""); setRate(""); setTaskDescription("");
      load();
    } catch (err) {
      setError(err.message);
    }
  }
  async function advance(timeEntryId, action) {
    try {
      await api("/api/orgs/legal/time-entries", { method: "PATCH", body: JSON.stringify({ orgId, timeEntryId, action }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }
  async function generateBill() {
    try {
      const data = await api("/api/orgs/legal/billing", { method: "POST", body: JSON.stringify({ orgId, matterId, arrangement: "hourly" }) });
      setBillResult(`Generated bill for $${data.billing.total}`);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <Section title={`Time & billing (${entries?.length ?? "…"})`}>
      <form onSubmit={logTime} className="flex flex-wrap gap-2 mb-2">
        <input value={taskDescription} onChange={(e) => setTaskDescription(e.target.value)} placeholder="Task" className="flex-1 min-w-[100px] bg-black/45 border border-white/15 rounded-lg px-2.5 py-1.5 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input value={minutes} onChange={(e) => setMinutes(e.target.value)} type="number" placeholder="Minutes" className="w-20 bg-black/45 border border-white/15 rounded-lg px-2.5 py-1.5 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input value={rate} onChange={(e) => setRate(e.target.value)} type="number" placeholder="Rate/hr" className="w-20 bg-black/45 border border-white/15 rounded-lg px-2.5 py-1.5 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <button className="text-[11px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3 py-1.5 rounded-lg">Log</button>
      </form>
      {error && <p className="text-red-400 text-[11px] mb-1">{error}</p>}
      {!entries || entries.length === 0 ? <Empty /> : entries.map((t) => (
        <div key={t.id} className="flex items-center justify-between bg-black/20 border border-white/5 rounded-lg px-3 py-1.5 gap-2">
          <span className="text-[var(--inaya-text-primary)] text-xs truncate">{t.taskDescription} · {t.minutes}min</span>
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="text-[10px] font-mono text-[var(--inaya-text-muted)]">{t.status}</span>
            {t.status === "DRAFT" && <button onClick={() => advance(t.id, "submit")} className="text-[10px] font-bold uppercase text-[#00f2fe]">Submit</button>}
            {t.status === "SUBMITTED" && <button onClick={() => advance(t.id, "approve")} className="text-[10px] font-bold uppercase text-emerald-400">Approve</button>}
          </div>
        </div>
      ))}
      <button onClick={generateBill} className="mt-2 text-[11px] font-bold uppercase text-[#00f2fe]">Generate hourly bill from approved time</button>
      {billResult && <p className="text-emerald-400 text-[11px] mt-1">{billResult}</p>}
    </Section>
  );
}

function TrustAccountingSection({ orgId, matterId }) {
  const [balance, setBalance] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [amount, setAmount] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await api(`/api/orgs/legal/trust-accounting?orgId=${orgId}&matterId=${matterId}`);
      setBalance(data.balance);
      setTransactions(data.transactions);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId, matterId]);

  useEffect(() => { load(); }, [load]);

  async function transact(type) {
    const amt = parseFloat(amount);
    if (!amt) return;
    try {
      await api("/api/orgs/legal/trust-accounting", { method: "POST", body: JSON.stringify({ orgId, matterId, type, amount: amt }) });
      setAmount("");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <Section title={`Trust accounting — balance: ${balance === null ? "…" : `$${balance}`}`}>
      <p className="text-[11px] text-[var(--inaya-text-muted)] mb-2">A withdrawal can never exceed this matter's real trust balance — enforced server-side, not just in this form.</p>
      <div className="flex flex-wrap gap-2 mb-2">
        <input value={amount} onChange={(e) => setAmount(e.target.value)} type="number" step="0.01" placeholder="Amount" className="w-28 bg-black/45 border border-white/15 rounded-lg px-2.5 py-1.5 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <button onClick={() => transact("deposit")} className="text-[11px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3 py-1.5 rounded-lg">Deposit</button>
        <button onClick={() => transact("withdrawal")} className="text-[11px] font-bold uppercase text-red-300 bg-red-400/10 border border-red-400/30 px-3 py-1.5 rounded-lg">Withdraw</button>
      </div>
      {error && <p className="text-red-400 text-[11px] mb-1">{error}</p>}
      {transactions.length === 0 ? <Empty /> : transactions.map((t) => <Row key={t.id} left={`${t.type} — $${t.amount}`} right={t.createdAt?.slice(0, 10)} />)}
    </Section>
  );
}

// ============================================================
// CLIENTS / PROSPECTS / ENTITIES
// ============================================================
function ClientsTab({ orgId }) {
  const [clients, setClients] = useState(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await api(`/api/orgs/legal/clients?orgId=${orgId}`);
      setClients(data.clients);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  async function create(e) {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      await api("/api/orgs/legal/clients", { method: "POST", body: JSON.stringify({ orgId, name: name.trim() }) });
      setName("");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={create} className="flex flex-wrap gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Client name" className="bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab] w-56" />
        <button className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg">+ New client</button>
      </form>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!clients ? <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p> : clients.length === 0 ? <EmptyState compact icon="🤝" description="No clients yet." /> : (
          <div className="space-y-2">{clients.map((c) => <Row key={c.id} left={c.name} right={c.status} />)}</div>
        )}
      </div>
    </div>
  );
}

function ProspectsTab({ orgId }) {
  const [prospects, setProspects] = useState([]);
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  async function create(e) {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      const data = await api("/api/orgs/legal/prospects", { method: "POST", body: JSON.stringify({ orgId, name: name.trim() }) });
      setProspects((prev) => [...prev, data.prospect]);
      setName("");
    } catch (err) {
      setError(err.message);
    }
  }
  async function decide(prospectId, decision) {
    try {
      const data = await api("/api/orgs/legal/prospects", { method: "PATCH", body: JSON.stringify({ orgId, prospectId, decision }) });
      setProspects((prev) => prev.map((p) => (p.id === prospectId ? data.prospect : p)));
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-[var(--inaya-text-muted)] text-xs max-w-lg">Prospective clients are kept restricted (Confidential classification) — intake is tracked here separately from full clients until you decide to engage.</p>
      <form onSubmit={create} className="flex flex-wrap gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Prospect name" className="bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab] w-56" />
        <button className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg">+ Intake prospect</button>
      </form>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {prospects.length === 0 ? <EmptyState compact icon="📋" description="No prospects intaken this session yet." /> : (
          <div className="space-y-2">
            {prospects.map((p) => (
              <div key={p.id} className="flex items-center justify-between bg-black/20 border border-white/5 rounded-lg px-3 py-1.5 gap-2">
                <span className="text-[var(--inaya-text-primary)] text-xs truncate">{p.name}</span>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[10px] font-mono text-[var(--inaya-text-muted)]">{p.status}</span>
                  {p.status === "intake" && (
                    <>
                      <button onClick={() => decide(p.id, "engage")} className="text-[10px] font-bold uppercase text-emerald-400">Engage</button>
                      <button onClick={() => decide(p.id, "decline")} className="text-[10px] font-bold uppercase text-red-400">Decline</button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function EntitiesTab({ orgId }) {
  const [entities, setEntities] = useState(null);
  const [name, setName] = useState("");
  const [jurisdiction, setJurisdiction] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await api(`/api/orgs/legal/entities?orgId=${orgId}`);
      setEntities(data.entities);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  async function create(e) {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      await api("/api/orgs/legal/entities", { method: "POST", body: JSON.stringify({ orgId, name: name.trim(), jurisdiction: jurisdiction.trim() || undefined }) });
      setName(""); setJurisdiction("");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={create} className="flex flex-wrap gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Entity name" className="bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab] w-56" />
        <input value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value)} placeholder="Jurisdiction (optional)" className="bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab] w-40" />
        <button className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg">+ New entity</button>
      </form>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!entities ? <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p> : entities.length === 0 ? <EmptyState compact icon="🏢" description="No corporate entities yet." /> : (
          <div className="space-y-2">{entities.map((e) => <Row key={e.id} left={e.name} right={e.jurisdiction || "—"} />)}</div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// SHARED PRIMITIVES
// ============================================================
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

function Modal({ title, onClose, children, wide }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className={`bg-[var(--inaya-surface)] border border-white/10 rounded-2xl p-5 w-full ${wide ? "max-w-2xl" : "max-w-md"} max-h-[85vh] overflow-y-auto`}>
        <div className="flex items-center justify-between gap-3 mb-4">
          <h3 className="text-[var(--inaya-text-primary)] font-bold text-sm truncate">{title}</h3>
          <button onClick={onClose} className="text-[var(--inaya-text-muted)] hover:text-[var(--inaya-text-primary)] text-lg leading-none shrink-0">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
