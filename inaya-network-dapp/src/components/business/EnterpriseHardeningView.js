"use client";

// src/components/business/EnterpriseHardeningView.js
//
// Financial Services & Regulated Enterprise SOW, Phase 10 (§218, §273-274)
// — Enterprise Hardening's two concrete, buildable-in-this-codebase
// pieces: Regulated Export Packages and Migration runs. Cross-vertical,
// same self-contained-view pattern as every other View component.
//
// Everything else Phase 10's "Build:" list names (performance,
// penetration testing, sandbox environments, support tooling) is a real
// operational/infrastructure practice, not a data model this UI can
// meaningfully represent — see the Phase 10 commit message for the
// explicit, undropped accounting of those.

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../EmptyState";

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

export default function EnterpriseHardeningView({ orgId, email }) {
  const [tab, setTab] = useState("exportpackages");
  return (
    <div className="space-y-5">
      <div className="flex bg-[var(--inaya-surface)] border border-white/5 rounded-xl p-1 w-fit">
        {["export packages", "migrations"].map((t) => {
          const key = t.replace(/ /g, "");
          return <button key={t} onClick={() => setTab(key)} className={`px-3.5 py-2 text-[11px] font-bold uppercase rounded-lg ${tab === key ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>{t}</button>;
        })}
      </div>
      {tab === "exportpackages" && <ExportPackagesTab orgId={orgId} actorEmail={email} />}
      {tab === "migrations" && <MigrationsTab orgId={orgId} actorEmail={email} />}
    </div>
  );
}

function ExportPackagesTab({ orgId, actorEmail }) {
  const [requests, setRequests] = useState(null);
  const [packages, setPackages] = useState(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [verifyResult, setVerifyResult] = useState(null);

  const load = useCallback(async () => {
    try {
      setError("");
      const [reqData, pkgData] = await Promise.all([
        api(`/api/orgs/export-requests?orgId=${orgId}`),
        api(`/api/orgs/regulated-export-packages?orgId=${orgId}`),
      ]);
      setRequests(reqData.requests);
      setPackages(pkgData.packages);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  async function requestExport(e) {
    e.preventDefault();
    try {
      setError("");
      await api("/api/orgs/export-requests", { method: "POST", body: JSON.stringify({ orgId, reason: reason.trim(), scope: {}, format: "json" }) });
      setReason("");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function approve(requestId) {
    try {
      setError("");
      await api("/api/orgs/export-requests", { method: "PATCH", body: JSON.stringify({ orgId, requestId, approve: true }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function generatePackage(requestId) {
    try {
      setError("");
      // A minimal, honest demonstration record set -- a real call site
      // would pass whatever it already legitimately fetched for the
      // request's actual scope.
      await api("/api/orgs/regulated-export-packages", { method: "POST", body: JSON.stringify({ orgId, requestId, recordType: "risk", records: [{ id: "demo-1", category: "operational", severity: "medium" }] }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function verify(packageId) {
    try {
      setError("");
      const result = await api(`/api/orgs/regulated-export-packages/${packageId}?orgId=${orgId}&verify=1`);
      setVerifyResult({ packageId, ...result });
    } catch (err) {
      setError(err.message);
    }
  }

  if (!requests || !packages) return <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>;

  return (
    <div className="space-y-4">
      <form onSubmit={requestExport} className="flex gap-2">
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason for export" className="flex-1 bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <button disabled={!reason.trim()} className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg disabled:opacity-40">Request export</button>
      </form>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        <p className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)] mb-2">Export requests</p>
        {requests.length === 0 ? <EmptyState compact icon="📤" description="No export requests yet." /> : (
          <div className="space-y-2">
            {requests.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-3 bg-black/20 border border-white/5 rounded-lg p-3">
                <span className="text-[var(--inaya-text-primary)] text-sm truncate">{r.reason}</span>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full border border-white/10 text-[var(--inaya-text-muted)]">{r.status}</span>
                  {r.status === "REQUESTED" && <button onClick={() => approve(r.id)} className="text-[10px] font-bold uppercase text-emerald-400">Approve</button>}
                  {r.status === "APPROVED" && <button onClick={() => generatePackage(r.id)} className="text-[10px] font-bold uppercase text-[#00f2fe]">Generate package</button>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        <p className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)] mb-2">Regulated export packages</p>
        {packages.length === 0 ? <EmptyState compact icon="📦" description="No regulated export packages generated yet." /> : (
          <div className="space-y-2">
            {packages.map((p) => (
              <div key={p.id} className="bg-black/20 border border-white/5 rounded-lg p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[var(--inaya-text-primary)] text-sm">{p.manifest.recordType} · {p.manifest.recordCount} record(s)</span>
                  <button onClick={() => verify(p.id)} className="text-[10px] font-bold uppercase text-[#00f2fe]">Verify integrity</button>
                </div>
                <p className="text-[11px] font-mono text-[var(--inaya-text-muted)] mt-1">v{p.manifest.version} · {p.manifest.generatedAt} · chain {p.chainVerificationResult.valid ? "intact" : "BROKEN"}</p>
                {verifyResult?.packageId === p.id && <p className={`text-[11px] font-mono mt-1 ${verifyResult.valid ? "text-emerald-400" : "text-red-400"}`}>{verifyResult.valid ? "Hash verified — unchanged since generation." : "INTEGRITY FAILURE — stored content no longer matches its hash."}</p>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const MIGRATION_STATUS_STYLES = {
  PENDING_APPROVAL: "border-amber-400/30 text-amber-400",
  APPROVED: "border-[#00f2fe]/30 text-[#00f2fe]",
  REJECTED: "border-red-400/30 text-red-400",
  COMPLETED: "border-emerald-400/30 text-emerald-400",
};

function MigrationsTab({ orgId, actorEmail }) {
  const [migrations, setMigrations] = useState(null);
  const [recordType, setRecordType] = useState("risk");
  const [sourceLabel, setSourceLabel] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setError("");
      setMigrations((await api(`/api/orgs/migrations?orgId=${orgId}`)).migrations);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  async function plan(e) {
    e.preventDefault();
    try {
      setError("");
      // A minimal, honest single-record demonstration import — a real
      // onboarding engagement would supply a real parsed file here.
      const sampleRecord = recordType === "risk" ? { category: "operational", severity: "medium" }
        : recordType === "vendor" ? { name: "Sample Vendor", service: "sample" }
        : { name: "Sample Control" };
      await api("/api/orgs/migrations", { method: "POST", body: JSON.stringify({ orgId, recordType, sourceLabel: sourceLabel.trim() || "manual entry", records: [sampleRecord] }) });
      setSourceLabel("");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function act(migrationId, action) {
    try {
      setError("");
      await api(`/api/orgs/migrations/${migrationId}`, { method: "PATCH", body: JSON.stringify({ orgId, action }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  if (!migrations) return <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>;

  return (
    <div className="space-y-4">
      <form onSubmit={plan} className="flex flex-wrap gap-2">
        <select value={recordType} onChange={(e) => setRecordType(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)]">
          {["risk", "vendor", "control"].map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <input value={sourceLabel} onChange={(e) => setSourceLabel(e.target.value)} placeholder="Source system label" className="flex-1 min-w-[160px] bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <button className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg">Plan migration</button>
      </form>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {migrations.length === 0 ? <EmptyState compact icon="📥" description="No migration runs yet." /> : (
          <div className="space-y-2">
            {migrations.map((m) => (
              <div key={m.id} className="bg-black/20 border border-white/5 rounded-lg p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[var(--inaya-text-primary)] text-sm">{m.recordType} from {m.source}</span>
                  <div className="flex items-center gap-2">
                    <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full border ${MIGRATION_STATUS_STYLES[m.status]}`}>{m.status.replace(/_/g, " ")}</span>
                    {m.status === "PENDING_APPROVAL" && <button onClick={() => act(m.id, "approve")} className="text-[10px] font-bold uppercase text-emerald-400">Approve</button>}
                    {m.status === "PENDING_APPROVAL" && <button onClick={() => act(m.id, "reject")} className="text-[10px] font-bold uppercase text-red-400">Reject</button>}
                    {m.status === "APPROVED" && <button onClick={() => act(m.id, "execute")} className="text-[10px] font-bold uppercase text-[#00f2fe]">Execute</button>}
                  </div>
                </div>
                <p className="text-[11px] font-mono text-[var(--inaya-text-muted)] mt-1">
                  {m.recordsTotal} record(s) · {m.failures.length} failure(s)
                  {m.reconciliation && ` · ${m.reconciliation.newRecords} imported`}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
