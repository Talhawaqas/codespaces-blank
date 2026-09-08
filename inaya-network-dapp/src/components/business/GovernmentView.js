"use client";

// src/components/business/GovernmentView.js
//
// Government & Public Sector Sovereign OS SOW, Phase 1 — Government OS tab
// of the Business Workspace. Same self-contained-view pattern as
// HealthView.js/RegulatedView.js: its own api() helper, no dependency on
// business/page.js internals beyond {orgId, canManage, email}.
//
// Citizen Records tab deliberately never renders a record's full content
// from the list response (metadata only, per citizen-records.js's own
// list-vs-detail split) — opening a record makes a SEPARATE request that
// can fail with 403 if the current user isn't assigned to it, exactly the
// need-to-know property test/citizen-records.test.mjs proves server-side.

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../EmptyState";

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

const CASE_STATUS_STYLES = {
  OPEN: "bg-red-400/10 text-red-400 border-red-400/30",
  ASSIGNED: "bg-amber-400/10 text-amber-400 border-amber-400/30",
  IN_PROGRESS: "bg-amber-400/10 text-amber-400 border-amber-400/30",
  PENDING_REVIEW: "bg-[#00f2fe]/10 text-[#00f2fe] border-[#00f2fe]/30",
  RESOLVED: "bg-emerald-400/10 text-emerald-400 border-emerald-400/30",
  CLOSED: "bg-white/5 text-[var(--inaya-text-muted)] border-white/10",
};

export default function GovernmentView({ orgId, canManage, email }) {
  const [tab, setTab] = useState("records");
  const TABS = [
    ["records", "Citizen Records"], ["cases", "Cases"], ["policyKb", "Policy Knowledge Base"], ["dashboard", "Dashboard"],
  ];

  return (
    <div className="space-y-5">
      <div className="flex bg-[var(--inaya-surface)] border border-white/5 rounded-xl p-1 w-fit flex-wrap">
        {TABS.map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)} className={`px-4 py-2 text-xs font-bold uppercase rounded-lg ${tab === key ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>{label}</button>
        ))}
      </div>
      {tab === "records" && <CitizenRecordsTab orgId={orgId} email={email} />}
      {tab === "cases" && <CasesTab orgId={orgId} />}
      {tab === "policyKb" && <PolicyKbTab orgId={orgId} />}
      {tab === "dashboard" && <DashboardTab orgId={orgId} />}
    </div>
  );
}

// ============================================================
// CITIZEN RECORDS
// ============================================================
function CitizenRecordsTab({ orgId, email }) {
  const [records, setRecords] = useState(null);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [legalName, setLegalName] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [openRecord, setOpenRecord] = useState(null); // full-content record, or a {error} shape

  const load = useCallback(async () => {
    try {
      const data = await api(`/api/orgs/government/citizen-records?orgId=${orgId}`);
      setRecords(data.records);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  async function create(e) {
    e.preventDefault();
    if (!legalName.trim()) return;
    try {
      await api("/api/orgs/government/citizen-records", { method: "POST", body: JSON.stringify({ orgId, legalName: legalName.trim(), dateOfBirth: dateOfBirth || null }) });
      setLegalName(""); setDateOfBirth(""); setShowCreate(false);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function open(recordId) {
    setOpenRecord(null);
    try {
      const data = await api(`/api/orgs/government/citizen-records/${recordId}?orgId=${orgId}`);
      setOpenRecord(data.record);
    } catch (err) {
      // Need-to-know: a 403 here is an honest, expected outcome for a
      // record this user isn't assigned to — shown plainly, not hidden.
      setOpenRecord({ _accessError: err.message });
    }
  }

  async function assignSelf(recordId) {
    try {
      await api(`/api/orgs/government/citizen-records/${recordId}/assign`, { method: "POST", body: JSON.stringify({ orgId, memberEmail: email }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => setShowCreate((v) => !v)} className="ml-auto text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg">+ New record</button>
      </div>
      {showCreate && (
        <form onSubmit={create} className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5 flex flex-wrap gap-2">
          <input value={legalName} onChange={(e) => setLegalName(e.target.value)} placeholder="Legal name" className="flex-1 min-w-[160px] bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
          <input type="date" value={dateOfBirth} onChange={(e) => setDateOfBirth(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)]" />
          <button disabled={!legalName.trim()} className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg disabled:opacity-40">Create</button>
        </form>
      )}
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!records ? <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p> : records.length === 0 ? (
          <EmptyState compact icon="🪪" description="No citizen records yet." ctaLabel="Create a record" onCta={() => setShowCreate(true)} />
        ) : (
          <div className="space-y-2">
            {records.map((r) => (
              <div key={r._id} className="flex items-center justify-between gap-3 bg-black/20 border border-white/5 rounded-lg p-3">
                <div className="min-w-0">
                  <span className="text-[var(--inaya-text-primary)] text-sm">{r.legalName}</span>
                  <p className="text-[var(--inaya-text-muted)] text-[12px] font-mono mt-0.5">{r.department || "no department"} · {r.classification}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button onClick={() => open(r._id)} className="text-[11px] font-bold uppercase px-2 py-1 rounded-lg border border-white/10 text-[var(--inaya-text-muted)] hover:text-[var(--inaya-text-primary)]">Open</button>
                  {canManage && <button onClick={() => assignSelf(r._id)} className="text-[11px] font-bold uppercase px-2 py-1 rounded-lg border border-white/10 text-[var(--inaya-text-muted)] hover:text-[var(--inaya-text-primary)]">Assign me</button>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {openRecord && (
        <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
          {openRecord._accessError ? (
            <p className="text-amber-400 text-sm">Access denied: {openRecord._accessError} — need-to-know access means being listed isn't the same as being assigned.</p>
          ) : (
            <div className="space-y-1 text-sm text-[var(--inaya-text-primary)]">
              <p><span className="text-[var(--inaya-text-muted)]">Legal name:</span> {openRecord.legalName}</p>
              <p><span className="text-[var(--inaya-text-muted)]">Date of birth:</span> {openRecord.dateOfBirth || "—"}</p>
              <p><span className="text-[var(--inaya-text-muted)]">Status:</span> {openRecord.status}</p>
              <p><span className="text-[var(--inaya-text-muted)]">Classification:</span> {openRecord.classification}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================
// CASES
// ============================================================
const NEXT_ACTION = { OPEN: "assign", ASSIGNED: "start", IN_PROGRESS: "submitForReview", PENDING_REVIEW: "resolve", RESOLVED: "close" };

function CasesTab({ orgId }) {
  const [cases, setCases] = useState(null);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("citizen_services");
  const [priority, setPriority] = useState("medium");

  const load = useCallback(async () => {
    try {
      const data = await api(`/api/orgs/government/cases?orgId=${orgId}`);
      setCases(data.cases);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  async function create(e) {
    e.preventDefault();
    if (!title.trim()) return;
    try {
      await api("/api/orgs/government/cases", { method: "POST", body: JSON.stringify({ orgId, category, priority, title: title.trim() }) });
      setTitle(""); setShowCreate(false);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function advance(caseId, action) {
    try {
      await api(`/api/orgs/government/cases/${caseId}/transition`, { method: "POST", body: JSON.stringify({ orgId, action }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => setShowCreate((v) => !v)} className="ml-auto text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg">+ Open case</button>
      </div>
      {showCreate && (
        <form onSubmit={create} className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5 flex flex-wrap gap-2">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Case title" className="flex-1 min-w-[160px] bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
          <select value={category} onChange={(e) => setCategory(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)]">
            {["citizen_services", "regulatory", "procurement_dispute", "records_request", "internal_investigation", "interdepartmental", "policy_exception", "other"].map((c) => <option key={c} value={c}>{c.replace(/_/g, " ")}</option>)}
          </select>
          <select value={priority} onChange={(e) => setPriority(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)]">
            {["low", "medium", "high", "urgent"].map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <button disabled={!title.trim()} className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg disabled:opacity-40">Open</button>
        </form>
      )}
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!cases ? <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p> : cases.length === 0 ? (
          <EmptyState compact icon="📋" description="No cases yet." ctaLabel="Open a case" onCta={() => setShowCreate(true)} />
        ) : (
          <div className="space-y-2">
            {cases.map((c) => (
              <div key={c._id} className="flex items-center justify-between gap-3 bg-black/20 border border-white/5 rounded-lg p-3">
                <div className="min-w-0">
                  <span className="text-[var(--inaya-text-primary)] text-sm">{c.title}</span>
                  <p className="text-[var(--inaya-text-muted)] text-[12px] font-mono mt-0.5">{c.category.replace(/_/g, " ")} · {c.priority}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={`text-[11px] font-bold uppercase px-2 py-0.5 rounded-full border ${CASE_STATUS_STYLES[c.status] || ""}`}>{c.status}</span>
                  {NEXT_ACTION[c.status] && <button onClick={() => advance(c._id, NEXT_ACTION[c.status])} className="text-[11px] font-bold uppercase px-2 py-1 rounded-lg border border-white/10 text-[var(--inaya-text-muted)] hover:text-[var(--inaya-text-primary)]">{NEXT_ACTION[c.status]}</button>}
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
// POLICY KNOWLEDGE BASE
// ============================================================
function PolicyKbTab({ orgId }) {
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [key, setKey] = useState("");
  const [title, setTitle] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await api(`/api/orgs/government/policy-kb?orgId=${orgId}`);
      setEntries(data.entries);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  async function create(e) {
    e.preventDefault();
    if (!key.trim() || !title.trim()) return;
    try {
      await api("/api/orgs/government/policy-kb", { method: "POST", body: JSON.stringify({ orgId, key: key.trim(), title: title.trim() }) });
      setKey(""); setTitle(""); setShowCreate(false);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function transition(entryId, action) {
    try {
      await api(`/api/orgs/government/policy-kb/${entryId}/transition`, { method: "POST", body: JSON.stringify({ orgId, action }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function publish(entryId) {
    try {
      await api(`/api/orgs/government/policy-kb/${entryId}/publish`, { method: "POST", body: JSON.stringify({ orgId }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => setShowCreate((v) => !v)} className="ml-auto text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg">+ New entry</button>
      </div>
      {showCreate && (
        <form onSubmit={create} className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5 flex flex-wrap gap-2">
          <input value={key} onChange={(e) => setKey(e.target.value)} placeholder="Key (e.g. records-retention)" className="flex-1 min-w-[160px] bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" className="flex-1 min-w-[160px] bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-sm text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
          <button disabled={!key.trim() || !title.trim()} className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg disabled:opacity-40">Create</button>
        </form>
      )}
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!entries ? <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p> : entries.length === 0 ? (
          <EmptyState compact icon="📚" description="No policy knowledge base entries yet." ctaLabel="Create an entry" onCta={() => setShowCreate(true)} />
        ) : (
          <div className="space-y-2">
            {entries.map((e) => (
              <div key={e._id} className="flex items-center justify-between gap-3 bg-black/20 border border-white/5 rounded-lg p-3">
                <div className="min-w-0">
                  <span className="text-[var(--inaya-text-primary)] text-sm">{e.title}</span>
                  <p className="text-[var(--inaya-text-muted)] text-[12px] font-mono mt-0.5">{e.key} · v{e.version}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[11px] font-bold uppercase px-2 py-0.5 rounded-full border border-white/10 text-[var(--inaya-text-muted)]">{e.status}</span>
                  {e.status === "DRAFT" && <button onClick={() => transition(e._id, "submitForReview")} className="text-[11px] font-bold uppercase px-2 py-1 rounded-lg border border-white/10 text-[var(--inaya-text-muted)] hover:text-[var(--inaya-text-primary)]">Submit for review</button>}
                  {e.status === "IN_REVIEW" && <button onClick={() => transition(e._id, "approve")} className="text-[11px] font-bold uppercase px-2 py-1 rounded-lg border border-white/10 text-[var(--inaya-text-muted)] hover:text-[var(--inaya-text-primary)]">Approve</button>}
                  {e.status === "APPROVED" && <button onClick={() => publish(e._id)} className="text-[11px] font-bold uppercase px-2 py-1 rounded-lg border border-white/10 text-[var(--inaya-text-muted)] hover:text-[var(--inaya-text-primary)]">Publish</button>}
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
// DASHBOARD — operations + security readiness, two honest panels,
// never collapsed into one fabricated score (government-dashboard.js).
// ============================================================
function DashboardTab({ orgId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api(`/api/orgs/government/dashboard?orgId=${orgId}`).then(setData).catch((err) => setError(err.message));
  }, [orgId]);

  if (error) return <p className="text-red-400 text-xs">{error}</p>;
  if (!data) return <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5 space-y-2">
        <h3 className="text-sm font-bold uppercase text-[var(--inaya-text-primary)]">Operations</h3>
        <p className="text-[var(--inaya-text-muted)] text-sm">Citizen records: {data.operations.totalCitizenRecords}</p>
        <p className="text-[var(--inaya-text-muted)] text-sm">Open cases: {data.operations.openCases} / {data.operations.totalCases}</p>
        <p className="text-[var(--inaya-text-muted)] text-sm">Avg. resolution: {typeof data.operations.avgResolutionDays === "number" ? `${data.operations.avgResolutionDays} days` : "unknown (no resolved cases yet)"}</p>
      </div>
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5 space-y-2">
        <h3 className="text-sm font-bold uppercase text-[var(--inaya-text-primary)]">Security & Compliance Readiness</h3>
        <p className={`text-sm font-bold ${data.security.auditChainStatus === "valid" ? "text-emerald-400" : data.security.auditChainStatus === "COMPROMISED" ? "text-red-400" : "text-amber-400"}`}>
          Audit chain: {data.security.auditChainStatus}
        </p>
        <p className="text-[var(--inaya-text-muted)] text-sm">Unreviewed privileged/break-glass sessions: {data.security.unreviewedPrivilegedSessions} ({data.security.unreviewedBreakGlassGrants} break-glass)</p>
        <p className="text-[var(--inaya-text-muted)] text-sm">Policy entries expiring within 30 days: {data.security.policyEntriesExpiringSoon}</p>
      </div>
    </div>
  );
}
