"use client";

// src/components/business/RegulatedView.js
//
// Regulated Enterprise OS tab of the Business Workspace (Financial
// Services & Regulated Enterprise SOW, Phase 4) — Controls, Evidence,
// Findings & Remediation, Policies, Risk & Exceptions, Internal Audit,
// Examinations, and a Compliance Dashboard. Same self-contained-view
// pattern as HealthView.js/LegalView.js: its own api() helper, its own
// Modal, no dependency on business/page.js internals beyond
// {orgId, canManage, email}.
//
// The Dashboard tab's "Unknown" tile is deliberately never hidden and
// never styled like a pass — see compliance-health.js's header for why
// that distinction is the single most load-bearing rule of this phase.

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../EmptyState";

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

const FINDING_STATUS_STYLES = {
  OPEN: "bg-red-400/10 text-red-400 border-red-400/30",
  ASSIGNED: "bg-amber-400/10 text-amber-400 border-amber-400/30",
  IN_REMEDIATION: "bg-amber-400/10 text-amber-400 border-amber-400/30",
  READY_FOR_VALIDATION: "bg-[#00f2fe]/10 text-[#00f2fe] border-[#00f2fe]/30",
  VALIDATED: "bg-emerald-400/10 text-emerald-400 border-emerald-400/30",
  CLOSED: "bg-white/5 text-[var(--inaya-text-muted)] border-white/10",
};

export default function RegulatedView({ orgId, canManage, email }) {
  const [tab, setTab] = useState("controls");
  const TABS = [
    ["controls", "Controls"], ["evidence", "Evidence"], ["findings", "Findings & Remediation"],
    ["policies", "Policies"], ["risk", "Risk & Exceptions"], ["audits", "Internal Audit"],
    ["examinations", "Examinations"], ["dashboard", "Dashboard"],
  ];

  return (
    <div className="space-y-5">
      <div className="flex bg-[var(--inaya-surface)] border border-white/5 rounded-xl p-1 w-fit flex-wrap">
        {TABS.map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)} className={`px-4 py-2 text-xs font-bold uppercase rounded-lg ${tab === key ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>{label}</button>
        ))}
      </div>
      {tab === "controls" && <ControlsTab orgId={orgId} />}
      {tab === "evidence" && <EvidenceTab orgId={orgId} />}
      {tab === "findings" && <FindingsTab orgId={orgId} />}
      {tab === "policies" && <PoliciesTab orgId={orgId} />}
      {tab === "risk" && <RiskExceptionsTab orgId={orgId} />}
      {tab === "audits" && <AuditsTab orgId={orgId} />}
      {tab === "examinations" && <ExaminationsTab orgId={orgId} />}
      {tab === "dashboard" && <DashboardTab orgId={orgId} />}
    </div>
  );
}

// ============================================================
// CONTROLS
// ============================================================
function ControlsTab({ orgId }) {
  const [controls, setControls] = useState(null);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await api(`/api/orgs/regulated/controls?orgId=${orgId}`);
      setControls(data.controls);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  async function create(e) {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      await api("/api/orgs/regulated/controls", { method: "POST", body: JSON.stringify({ orgId, name: name.trim(), description: description.trim() }) });
      setName(""); setDescription(""); setShowCreate(false);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function activate(controlId) {
    try {
      await api(`/api/orgs/regulated/controls/${controlId}`, { method: "PATCH", body: JSON.stringify({ orgId, updates: { status: "active" } }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => setShowCreate((v) => !v)} className="ml-auto text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg">+ New control</button>
      </div>
      {showCreate && (
        <form onSubmit={create} className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5 flex flex-wrap gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Control name" className="flex-1 min-w-[160px] bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description (optional)" className="flex-1 min-w-[160px] bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
          <button disabled={!name.trim()} className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg disabled:opacity-40">Create</button>
        </form>
      )}
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!controls ? <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p> : controls.length === 0 ? (
          <EmptyState compact icon="🛡️" description="No controls yet." ctaLabel="Create a control" onCta={() => setShowCreate(true)} />
        ) : (
          <div className="space-y-2">
            {controls.map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-3 bg-black/20 border border-white/5 rounded-lg p-3">
                <div className="min-w-0">
                  <span className="text-[var(--inaya-text-primary)] text-sm">{c.name}</span>
                  <p className="text-[var(--inaya-text-muted)] text-[12px] font-mono mt-0.5">{c.effectiveness} · tested {c.lastTestedAt ? c.lastTestedAt.slice(0, 10) : "never"}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[11px] font-bold uppercase px-2 py-0.5 rounded-full border border-white/10 text-[var(--inaya-text-muted)]">{c.status}</span>
                  {c.status === "draft" && <button onClick={() => activate(c.id)} className="text-[10px] font-bold uppercase text-[#00f2fe]">Activate</button>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// EVIDENCE
// ============================================================
function EvidenceTab({ orgId }) {
  const [evidence, setEvidence] = useState(null);
  const [controlId, setControlId] = useState("");
  const [type, setType] = useState("policy");
  const [sourceRef, setSourceRef] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setEvidence((await api(`/api/orgs/regulated/evidence?orgId=${orgId}`)).evidence);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  async function submit(e) {
    e.preventDefault();
    if (!controlId.trim()) return;
    try {
      await api("/api/orgs/regulated/evidence", { method: "POST", body: JSON.stringify({ orgId, controlId: controlId.trim(), type, sourceRef: sourceRef.trim() || undefined }) });
      setControlId(""); setSourceRef("");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function review(evidenceId, reviewStatus) {
    try {
      await api(`/api/orgs/regulated/evidence/${evidenceId}/review`, { method: "PATCH", body: JSON.stringify({ orgId, reviewStatus }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={submit} className="flex flex-wrap gap-2">
        <input value={controlId} onChange={(e) => setControlId(e.target.value)} placeholder="Control ID" className="bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab] w-40" />
        <select value={type} onChange={(e) => setType(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
          {["policy", "procedure", "screenshot", "configuration_export", "log", "audit_record", "access_review", "training_record", "vendor_assessment", "penetration_test", "vulnerability_scan"].map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}
        </select>
        <input value={sourceRef} onChange={(e) => setSourceRef(e.target.value)} placeholder="Source reference (optional)" className="flex-1 min-w-[140px] bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <button disabled={!controlId.trim()} className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg disabled:opacity-40">Submit</button>
      </form>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!evidence ? <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p> : evidence.length === 0 ? (
          <EmptyState compact icon="📁" description="No evidence submitted yet." />
        ) : (
          <div className="space-y-2">
            {evidence.map((e) => (
              <div key={e.id} className="flex items-center justify-between gap-3 bg-black/20 border border-white/5 rounded-lg p-3">
                <span className="text-[var(--inaya-text-primary)] text-xs truncate">{e.type.replace(/_/g, " ")} {e.sourceRef ? `— ${e.sourceRef}` : ""}</span>
                {e.reviewStatus === "pending" ? (
                  <div className="flex items-center gap-2 shrink-0">
                    <button onClick={() => review(e.id, "approved")} className="text-[10px] font-bold uppercase text-emerald-400">Approve</button>
                    <button onClick={() => review(e.id, "rejected")} className="text-[10px] font-bold uppercase text-red-400">Reject</button>
                  </div>
                ) : <span className="text-[10px] font-mono text-[var(--inaya-text-muted)] shrink-0">{e.reviewStatus}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// FINDINGS & REMEDIATION
// ============================================================
const NEXT_FINDING_ACTION = { OPEN: "assign", ASSIGNED: "startRemediation", IN_REMEDIATION: "submitForValidation", READY_FOR_VALIDATION: "validate", VALIDATED: "close" };
const NEXT_FINDING_LABEL = { OPEN: "Assign", ASSIGNED: "Start remediation", IN_REMEDIATION: "Submit for validation", READY_FOR_VALIDATION: "Validate", VALIDATED: "Close" };

function FindingsTab({ orgId }) {
  const [findings, setFindings] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setFindings((await api(`/api/orgs/regulated/findings?orgId=${orgId}`)).findings);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  async function advance(findingId, status) {
    const action = NEXT_FINDING_ACTION[status];
    if (!action) return;
    try {
      await api(`/api/orgs/regulated/findings/${findingId}/transition`, { method: "PATCH", body: JSON.stringify({ orgId, action }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="space-y-4">
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!findings ? <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p> : findings.length === 0 ? (
          <EmptyState compact icon="✅" description="No findings — nothing has failed testing yet." />
        ) : (
          <div className="space-y-2">
            {findings.map((f) => (
              <div key={f.id} className="flex items-center justify-between gap-3 bg-black/20 border border-white/5 rounded-lg p-3">
                <div className="min-w-0">
                  <span className="text-[var(--inaya-text-primary)] text-sm">{f.description}</span>
                  <p className="text-[var(--inaya-text-muted)] text-[12px] font-mono mt-0.5">{f.severity} · {f.source.replace(/_/g, " ")}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={`text-[11px] font-bold uppercase px-2 py-0.5 rounded-full border ${FINDING_STATUS_STYLES[f.status] || FINDING_STATUS_STYLES.OPEN}`}>{f.status.replace(/_/g, " ")}</span>
                  {NEXT_FINDING_ACTION[f.status] && <button onClick={() => advance(f.id, f.status)} className="text-[10px] font-bold uppercase text-[#00f2fe] whitespace-nowrap">{NEXT_FINDING_LABEL[f.status]}</button>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// POLICIES
// ============================================================
function PoliciesTab({ orgId }) {
  const [policies, setPolicies] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [key, setKey] = useState("");
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setPolicies((await api(`/api/orgs/regulated/policies?orgId=${orgId}`)).policies);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  async function create(e) {
    e.preventDefault();
    if (!key.trim() || !title.trim()) return;
    try {
      await api("/api/orgs/regulated/policies", { method: "POST", body: JSON.stringify({ orgId, key: key.trim(), title: title.trim() }) });
      setKey(""); setTitle(""); setShowCreate(false);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  const NEXT_ACTION = { DRAFT: "submitForReview", IN_REVIEW: "approve", APPROVED: "publish" };
  const NEXT_LABEL = { DRAFT: "Submit for review", IN_REVIEW: "Approve", APPROVED: "Publish" };

  async function advance(policyId, status) {
    const action = NEXT_ACTION[status];
    if (!action) return;
    try {
      await api(`/api/orgs/regulated/policies/${policyId}/transition`, { method: "PATCH", body: JSON.stringify({ orgId, action }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function amend(policyId) {
    try {
      await api(`/api/orgs/regulated/policies/${policyId}/amend`, { method: "POST", body: JSON.stringify({ orgId }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function acknowledge(policyId) {
    try {
      await api(`/api/orgs/regulated/policies/${policyId}/transition`, { method: "PATCH", body: JSON.stringify({ orgId, action: "acknowledge" }) });
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => setShowCreate((v) => !v)} className="ml-auto text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg">+ New policy</button>
      </div>
      {showCreate && (
        <form onSubmit={create} className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5 flex flex-wrap gap-2">
          <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="Policy key (e.g. acceptable-use)" className="flex-1 min-w-[160px] bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" className="flex-1 min-w-[160px] bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
          <button disabled={!key.trim() || !title.trim()} className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg disabled:opacity-40">Draft</button>
        </form>
      )}
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!policies ? <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p> : policies.length === 0 ? (
          <EmptyState compact icon="📜" description="No policies yet." ctaLabel="Draft a policy" onCta={() => setShowCreate(true)} />
        ) : (
          <div className="space-y-2">
            {policies.map((p) => (
              <div key={p.id} className="flex items-center justify-between gap-3 bg-black/20 border border-white/5 rounded-lg p-3">
                <div className="min-w-0">
                  <span className="text-[var(--inaya-text-primary)] text-sm">{p.title}</span>
                  <p className="text-[var(--inaya-text-muted)] text-[12px] font-mono mt-0.5">{p.key} v{p.version}{p.immutable ? " · immutable" : ""}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[11px] font-bold uppercase px-2 py-0.5 rounded-full border border-white/10 text-[var(--inaya-text-muted)]">{p.status}</span>
                  {NEXT_ACTION[p.status] && <button onClick={() => advance(p.id, p.status)} className="text-[10px] font-bold uppercase text-[#00f2fe] whitespace-nowrap">{NEXT_LABEL[p.status]}</button>}
                  {p.status === "PUBLISHED" && (
                    <>
                      <button onClick={() => acknowledge(p.id)} className="text-[10px] font-bold uppercase text-emerald-400 whitespace-nowrap">Acknowledge</button>
                      <button onClick={() => amend(p.id)} className="text-[10px] font-bold uppercase text-amber-400 whitespace-nowrap">Amend</button>
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

// ============================================================
// RISK & EXCEPTIONS
// ============================================================
function RiskExceptionsTab({ orgId }) {
  const [exceptions, setExceptions] = useState(null);
  const [justification, setJustification] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setExceptions((await api(`/api/orgs/regulated/exceptions?orgId=${orgId}`)).exceptions);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  async function request(e) {
    e.preventDefault();
    if (!justification.trim() || !expiresAt) return;
    try {
      await api("/api/orgs/regulated/exceptions", { method: "POST", body: JSON.stringify({ orgId, justification: justification.trim(), expiresAt: new Date(expiresAt).toISOString() }) });
      setJustification(""); setExpiresAt("");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  const NEXT_ACTION = { REQUESTED: "approve", APPROVED: "activate", ACTIVE: "close" };
  const NEXT_LABEL = { REQUESTED: "Approve", APPROVED: "Activate", ACTIVE: "Close" };

  async function advance(exceptionId, status) {
    const action = NEXT_ACTION[status];
    if (!action) return;
    try {
      await api(`/api/orgs/regulated/exceptions/${exceptionId}/transition`, { method: "PATCH", body: JSON.stringify({ orgId, action }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-[var(--inaya-text-muted)] text-xs max-w-lg">Exceptions always require an expiry date — no permanent silent exceptions. The full risk register lives alongside every other Business Workspace module's risk entries; this view shows compliance exceptions specifically.</p>
      <form onSubmit={request} className="flex flex-wrap gap-2">
        <input value={justification} onChange={(e) => setJustification(e.target.value)} placeholder="Justification" className="flex-1 min-w-[160px] bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} type="date" className="bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)]" />
        <button disabled={!justification.trim() || !expiresAt} className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg disabled:opacity-40">Request exception</button>
      </form>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!exceptions ? <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p> : exceptions.length === 0 ? (
          <EmptyState compact icon="⚠️" description="No exceptions on file." />
        ) : (
          <div className="space-y-2">
            {exceptions.map((ex) => (
              <div key={ex.id} className="flex items-center justify-between gap-3 bg-black/20 border border-white/5 rounded-lg p-3">
                <div className="min-w-0">
                  <span className="text-[var(--inaya-text-primary)] text-sm truncate block">{ex.justification}</span>
                  <p className="text-[var(--inaya-text-muted)] text-[12px] font-mono mt-0.5">expires {ex.expiresAt?.slice(0, 10)}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[11px] font-bold uppercase px-2 py-0.5 rounded-full border border-white/10 text-[var(--inaya-text-muted)]">{ex.status}</span>
                  {NEXT_ACTION[ex.status] && <button onClick={() => advance(ex.id, ex.status)} className="text-[10px] font-bold uppercase text-[#00f2fe]">{NEXT_LABEL[ex.status]}</button>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// INTERNAL AUDIT
// ============================================================
function AuditsTab({ orgId }) {
  const [plans, setPlans] = useState(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setPlans((await api(`/api/orgs/regulated/audits?orgId=${orgId}`)).auditPlans);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  async function create(e) {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      await api("/api/orgs/regulated/audits", { method: "POST", body: JSON.stringify({ orgId, name: name.trim() }) });
      setName("");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  const NEXT_ACTION = { PLANNED: "startFieldwork", FIELDWORK: "startReporting", REPORTING: "close" };
  const NEXT_LABEL = { PLANNED: "Start fieldwork", FIELDWORK: "Start reporting", REPORTING: "Close" };

  async function advance(auditId, status) {
    const action = NEXT_ACTION[status];
    if (!action) return;
    try {
      await api(`/api/orgs/regulated/audits/${auditId}/transition`, { method: "PATCH", body: JSON.stringify({ orgId, action }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={create} className="flex flex-wrap gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Audit plan name" className="flex-1 min-w-[160px] bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <button disabled={!name.trim()} className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg disabled:opacity-40">Create plan</button>
      </form>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!plans ? <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p> : plans.length === 0 ? (
          <EmptyState compact icon="📋" description="No audit plans yet." />
        ) : (
          <div className="space-y-2">
            {plans.map((p) => (
              <div key={p.id} className="flex items-center justify-between gap-3 bg-black/20 border border-white/5 rounded-lg p-3">
                <div className="min-w-0">
                  <span className="text-[var(--inaya-text-primary)] text-sm">{p.name}</span>
                  <p className="text-[var(--inaya-text-muted)] text-[12px] font-mono mt-0.5">line {p.line} · {p.findingIds.length} finding(s)</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[11px] font-bold uppercase px-2 py-0.5 rounded-full border border-white/10 text-[var(--inaya-text-muted)]">{p.status}</span>
                  {NEXT_ACTION[p.status] && <button onClick={() => advance(p.id, p.status)} className="text-[10px] font-bold uppercase text-[#00f2fe] whitespace-nowrap">{NEXT_LABEL[p.status]}</button>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// EXAMINATIONS
// ============================================================
function ExaminationsTab({ orgId }) {
  const [examinations, setExaminations] = useState(null);
  const [examinerOrgName, setExaminerOrgName] = useState("");
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(null);

  const load = useCallback(async () => {
    try {
      setExaminations((await api(`/api/orgs/regulated/examinations?orgId=${orgId}`)).examinations);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  async function create(e) {
    e.preventDefault();
    if (!examinerOrgName.trim()) return;
    try {
      await api("/api/orgs/regulated/examinations", { method: "POST", body: JSON.stringify({ orgId, examinerOrgName: examinerOrgName.trim() }) });
      setExaminerOrgName("");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  const NEXT_ACTION = { SCOPING: "activate", ACTIVE: "beginReview", RESPONSE_REVIEW: "close" };
  const NEXT_LABEL = { SCOPING: "Activate", ACTIVE: "Begin review", RESPONSE_REVIEW: "Close" };

  async function advance(examinationId, status) {
    const action = NEXT_ACTION[status];
    if (!action) return;
    try {
      await api("/api/orgs/regulated/examinations", { method: "PATCH", body: JSON.stringify({ orgId, examinationId, action }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={create} className="flex flex-wrap gap-2">
        <input value={examinerOrgName} onChange={(e) => setExaminerOrgName(e.target.value)} placeholder="Examining organization name" className="flex-1 min-w-[160px] bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <button disabled={!examinerOrgName.trim()} className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg disabled:opacity-40">Open examination</button>
      </form>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!examinations ? <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p> : examinations.length === 0 ? (
          <EmptyState compact icon="🔍" description="No regulatory examinations yet." />
        ) : (
          <div className="space-y-2">
            {examinations.map((ex) => (
              <button key={ex.id} onClick={() => setSelected(ex)} className="w-full flex items-center justify-between gap-3 bg-black/20 border border-white/5 rounded-lg p-3 text-left hover:bg-white/5">
                <span className="text-[var(--inaya-text-primary)] text-sm">{ex.examinerOrgName}</span>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[11px] font-bold uppercase px-2 py-0.5 rounded-full border border-white/10 text-[var(--inaya-text-muted)]">{ex.status}</span>
                  {NEXT_ACTION[ex.status] && <span onClick={(e) => { e.stopPropagation(); advance(ex.id, ex.status); }} className="text-[10px] font-bold uppercase text-[#00f2fe] whitespace-nowrap">{NEXT_LABEL[ex.status]}</span>}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
      {selected && <ExaminationRequestsModal orgId={orgId} examination={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function ExaminationRequestsModal({ orgId, examination, onClose }) {
  const [requests, setRequests] = useState(null);
  const [description, setDescription] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [examinerEmail, setExaminerEmail] = useState("");
  const [issuedToken, setIssuedToken] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setRequests((await api(`/api/orgs/regulated/examinations/${examination.id}/requests?orgId=${orgId}`)).requests);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId, examination.id]);

  useEffect(() => { load(); }, [load]);

  async function createRequest(e) {
    e.preventDefault();
    if (!description.trim()) return;
    try {
      await api(`/api/orgs/regulated/examinations/${examination.id}/requests`, { method: "POST", body: JSON.stringify({ orgId, description: description.trim(), ownerEmail: ownerEmail.trim() || undefined }) });
      setDescription(""); setOwnerEmail("");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function approveReject(requestId, action) {
    try {
      await api(`/api/orgs/regulated/examinations/${examination.id}/requests/${requestId}`, { method: "PATCH", body: JSON.stringify({ orgId, action }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function issueAccess(e) {
    e.preventDefault();
    if (!examinerEmail.trim()) return;
    try {
      const data = await api(`/api/orgs/regulated/examinations/${examination.id}/access`, { method: "POST", body: JSON.stringify({ orgId, examinerEmail: examinerEmail.trim() }) });
      setIssuedToken(data.token);
      setExaminerEmail("");
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="bg-[var(--inaya-surface)] border border-white/10 rounded-2xl p-5 w-full max-w-2xl max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between gap-3 mb-4">
          <h3 className="text-[var(--inaya-text-primary)] font-bold text-sm truncate">{examination.examinerOrgName}</h3>
          <button onClick={onClose} className="text-[var(--inaya-text-muted)] hover:text-[var(--inaya-text-primary)] text-lg leading-none shrink-0">×</button>
        </div>

        <p className="text-[11px] font-bold uppercase tracking-wide text-[var(--inaya-text-muted)] mb-1.5">Evidence requests</p>
        <form onSubmit={createRequest} className="flex flex-wrap gap-2 mb-2">
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description" className="flex-1 min-w-[140px] bg-black/45 border border-white/15 rounded-lg px-2.5 py-1.5 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
          <input value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} type="email" placeholder="Owner email (optional)" className="flex-1 min-w-[140px] bg-black/45 border border-white/15 rounded-lg px-2.5 py-1.5 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
          <button className="text-[11px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3 py-1.5 rounded-lg">Add</button>
        </form>
        {error && <p className="text-red-400 text-[11px] mb-2">{error}</p>}
        <div className="space-y-1 mb-4">
          {!requests || requests.length === 0 ? <p className="text-[var(--inaya-text-muted)] text-[11px] font-mono">None.</p> : requests.map((r) => (
            <div key={r.id} className="flex items-center justify-between bg-black/20 border border-white/5 rounded-lg px-3 py-1.5 gap-2">
              <span className="text-[var(--inaya-text-primary)] text-xs truncate">{r.description}</span>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-[10px] font-mono text-[var(--inaya-text-muted)]">{r.status}</span>
                {r.status === "SUBMITTED" && (
                  <>
                    <button onClick={() => approveReject(r.id, "approve")} className="text-[10px] font-bold uppercase text-emerald-400">Approve</button>
                    <button onClick={() => approveReject(r.id, "reject")} className="text-[10px] font-bold uppercase text-red-400">Reject</button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>

        <p className="text-[11px] font-bold uppercase tracking-wide text-[var(--inaya-text-muted)] mb-1.5">Examiner access</p>
        <form onSubmit={issueAccess} className="flex flex-wrap gap-2">
          <input value={examinerEmail} onChange={(e) => setExaminerEmail(e.target.value)} type="email" placeholder="Examiner email" className="flex-1 min-w-[140px] bg-black/45 border border-white/15 rounded-lg px-2.5 py-1.5 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
          <button className="text-[11px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3 py-1.5 rounded-lg">Issue access link</button>
        </form>
        {issuedToken && (
          <p className="text-emerald-400 text-[11px] mt-2 break-all">Access token issued — send this examiner to /api/regulatory-examiner/{issuedToken} (valid 30 minutes, one-time use).</p>
        )}
      </div>
    </div>
  );
}

// ============================================================
// DASHBOARD
// ============================================================
function DashboardTab({ orgId }) {
  const [health, setHealth] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api(`/api/orgs/regulated/dashboard?orgId=${orgId}`).then(setHealth).catch((err) => setError(err.message));
  }, [orgId]);

  if (error) return <p className="text-red-400 text-xs">{error}</p>;
  if (!health) return <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>;

  const STATUS_COLORS = { green: "text-emerald-400 border-emerald-400/30 bg-emerald-400/10", amber: "text-amber-400 border-amber-400/30 bg-amber-400/10", red: "text-red-400 border-red-400/30 bg-red-400/10", unknown: "text-[var(--inaya-text-muted)] border-white/10 bg-white/5" };

  return (
    <div className="space-y-4">
      <div className={`inline-block text-xs font-bold uppercase px-3 py-1.5 rounded-full border ${STATUS_COLORS[health.overallStatus]}`}>Overall: {health.overallStatus}</div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Tile label="Passing" value={health.controlsPassing} tone="good" />
        <Tile label="Failing" value={health.controlsFailing} tone="bad" />
        {/* Unknown is deliberately its own tile, never merged into Passing — a
            control with no test record is unknown, not compliant. */}
        <Tile label="Unknown" value={health.controlsUnknown} tone="unknown" />
        <Tile label="Total controls" value={health.totalControls} tone="neutral" />
        <Tile label="Evidence expiring soon" value={health.evidenceExpiringSoon} tone={health.evidenceExpiringSoon > 0 ? "warn" : "neutral"} />
        <Tile label="Overdue reviews" value={health.overdueReviews} tone={health.overdueReviews > 0 ? "warn" : "neutral"} />
        <Tile label="Open findings" value={health.openFindings} tone={health.openFindings > 0 ? "warn" : "neutral"} />
        <Tile label="Critical findings" value={health.criticalFindings} tone={health.criticalFindings > 0 ? "bad" : "neutral"} />
      </div>
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        <p className="text-[11px] font-bold uppercase tracking-wide text-[var(--inaya-text-muted)] mb-2">Remediation progress</p>
        {health.remediationProgress.total === 0 ? (
          <p className="text-[var(--inaya-text-muted)] text-[11px] font-mono">No findings recorded yet.</p>
        ) : (
          <p className="text-[var(--inaya-text-primary)] text-sm">{health.remediationProgress.closed} of {health.remediationProgress.total} findings closed ({health.remediationProgress.percentComplete}%)</p>
        )}
      </div>
      {health.frameworkCoverage.length > 0 && (
        <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
          <p className="text-[11px] font-bold uppercase tracking-wide text-[var(--inaya-text-muted)] mb-2">Framework coverage</p>
          <div className="space-y-1.5">
            {health.frameworkCoverage.map((fc) => (
              <div key={fc.frameworkId} className="flex items-center justify-between bg-black/20 border border-white/5 rounded-lg px-3 py-1.5">
                <span className="text-[var(--inaya-text-primary)] text-xs">{fc.frameworkId}</span>
                <span className="text-[var(--inaya-text-muted)] text-[11px] font-mono">{fc.coveredRequirements}/{fc.totalRequirements} requirements ({fc.coveragePercent === null ? "—" : `${fc.coveragePercent}%`})</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Tile({ label, value, tone }) {
  const TONE_STYLES = {
    good: "text-emerald-400", bad: "text-red-400", warn: "text-amber-400",
    unknown: "text-[var(--inaya-text-muted)]", neutral: "text-[var(--inaya-text-primary)]",
  };
  return (
    <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-4">
      <p className={`text-2xl font-bold ${TONE_STYLES[tone]}`}>{value}</p>
      <p className="text-[var(--inaya-text-muted)] text-[11px] font-mono uppercase tracking-wide mt-1">{label}</p>
    </div>
  );
}
