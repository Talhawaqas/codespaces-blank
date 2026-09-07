"use client";

// src/components/business/ExecutiveDashboardView.js
//
// Financial Services & Regulated Enterprise SOW, Phase 8 (§113-115,
// §189-192) — Executive / Board Layer. Cross-vertical, same self-
// contained-view pattern as every other View component in this app.
// Four tabs: Command Center (the top-level aggregate), Trust Health
// (ten explainable dimensions), Risk & Compliance (the two executive
// dashboards), and Board Reports (draft/publish).

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../EmptyState";

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

const STATUS_STYLES = {
  green: "border-emerald-400/30 text-emerald-400",
  amber: "border-amber-400/30 text-amber-400",
  red: "border-red-400/30 text-red-400",
  unknown: "border-white/10 text-[var(--inaya-text-muted)]",
};

function StatusPill({ status }) {
  return <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full border ${STATUS_STYLES[status] || STATUS_STYLES.unknown}`}>{status}</span>;
}

export default function ExecutiveDashboardView({ orgId, email }) {
  const [tab, setTab] = useState("commandcenter");
  const TABS = ["command center", "trust health", "risk & compliance", "board reports"];
  return (
    <div className="space-y-5">
      <div className="flex bg-[var(--inaya-surface)] border border-white/5 rounded-xl p-1 w-fit flex-wrap">
        {TABS.map((t) => {
          const key = t.replace(/[^a-z]/gi, "").toLowerCase();
          return <button key={t} onClick={() => setTab(key)} className={`px-3.5 py-2 text-[11px] font-bold uppercase rounded-lg ${tab === key ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>{t}</button>;
        })}
      </div>
      {tab === "commandcenter" && <CommandCenterTab orgId={orgId} />}
      {tab === "trusthealth" && <TrustHealthTab orgId={orgId} />}
      {tab === "riskcompliance" && <RiskComplianceTab orgId={orgId} />}
      {tab === "boardreports" && <BoardReportsTab orgId={orgId} actorEmail={email} />}
    </div>
  );
}

// ============================================================
// COMMAND CENTER
// ============================================================
function CommandCenterTab({ orgId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api(`/api/orgs/executive/command-center?orgId=${orgId}`).then(setData).catch((err) => setError(err.message));
  }, [orgId]);

  if (error) return <p className="text-red-400 text-xs">{error}</p>;
  if (!data) return <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat label="Trust health" value={data.trustHealth.overallStatus} status={data.trustHealth.overallStatus} />
        <Stat label="Open risks" value={data.riskDashboard.totalOpenRisks} />
        <Stat label="Compliance posture" value={data.complianceDashboard.compliancePosture.overallStatus} status={data.complianceDashboard.compliancePosture.overallStatus} />
        <Stat label="Pending approvals" value={data.pendingApprovalCount} warn={data.pendingApprovalCount > 0} />
      </div>
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        <p className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)] mb-2">Board reporting</p>
        <p className="text-[12px] font-mono text-[var(--inaya-text-muted)]">
          Latest published: {data.boardReporting.latestPublishedAt || "none yet"}
          {data.boardReporting.hasUnpublishedDraft && " — an unpublished draft exists"}
        </p>
      </div>
    </div>
  );
}

function Stat({ label, value, warn, status }) {
  return (
    <div className={`bg-black/20 border rounded-lg p-2.5 ${warn ? "border-amber-400/30" : "border-white/5"}`}>
      <p className="text-[10px] font-bold uppercase text-[var(--inaya-text-muted)]">{label}</p>
      {status ? <StatusPill status={status} /> : <p className={`text-sm font-mono mt-0.5 ${warn ? "text-amber-400" : "text-[var(--inaya-text-primary)]"}`}>{value}</p>}
    </div>
  );
}

// ============================================================
// TRUST HEALTH 2.0
// ============================================================
function TrustHealthTab({ orgId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api(`/api/orgs/executive/trust-health?orgId=${orgId}`).then(setData).catch((err) => setError(err.message));
  }, [orgId]);

  if (error) return <p className="text-red-400 text-xs">{error}</p>;
  if (!data) return <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 mb-2">
        <StatusPill status={data.overallStatus} />
        <span className="text-[11px] font-mono text-[var(--inaya-text-muted)]">{data.dimensionsScored}/{data.dimensionsTotal} dimensions scored</span>
      </div>
      {Object.entries(data.dimensions).map(([name, dim]) => (
        <div key={name} className="bg-black/20 border border-white/5 rounded-lg p-3">
          <div className="flex items-center justify-between gap-3 mb-1">
            <span className="text-[var(--inaya-text-primary)] text-sm">{name.replace(/_/g, " ")}</span>
            <StatusPill status={dim.status} />
          </div>
          {dim.contributingFactors.map((f, i) => <p key={i} className="text-[11px] font-mono text-[var(--inaya-text-muted)]">{f}</p>)}
          {dim.scopeNotes && <p className="text-[11px] font-mono text-amber-400/70 mt-1">{dim.scopeNotes}</p>}
        </div>
      ))}
    </div>
  );
}

// ============================================================
// RISK & COMPLIANCE
// ============================================================
function RiskComplianceTab({ orgId }) {
  const [risk, setRisk] = useState(null);
  const [compliance, setCompliance] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([
      api(`/api/orgs/executive/risk-dashboard?orgId=${orgId}`),
      api(`/api/orgs/executive/compliance-dashboard?orgId=${orgId}`),
    ]).then(([r, c]) => { setRisk(r); setCompliance(c); }).catch((err) => setError(err.message));
  }, [orgId]);

  if (error) return <p className="text-red-400 text-xs">{error}</p>;
  if (!risk || !compliance) return <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>;

  return (
    <div className="space-y-4">
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        <p className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)] mb-2">Top risks by category</p>
        {Object.entries(risk.topRisks).every(([, list]) => list.length === 0) ? <EmptyState compact icon="⚠️" description="No open risks on file." /> : (
          <div className="space-y-3">
            {Object.entries(risk.topRisks).filter(([, list]) => list.length > 0).map(([category, list]) => (
              <div key={category}>
                <p className="text-[10px] font-bold uppercase text-[var(--inaya-text-muted)] mb-1">{category}</p>
                {list.map((r) => <Row key={r.id} left={r.category} right={r.severity} />)}
              </div>
            ))}
          </div>
        )}
        <p className="text-[11px] font-mono text-[var(--inaya-text-muted)] mt-2">{risk.majorIncidentCount} major incident(s) · {risk.overdueActions} overdue action(s)</p>
      </div>
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        <p className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)] mb-2">Compliance posture</p>
        <div className="flex items-center gap-2 mb-2"><StatusPill status={compliance.compliancePosture.overallStatus} /></div>
        <Row left="Controls passing / failing / unknown" right={`${compliance.compliancePosture.controlsPassing} / ${compliance.compliancePosture.controlsFailing} / ${compliance.compliancePosture.controlsUnknown}`} />
        <Row left="Critical vendors at risk" right={compliance.vendorRisk.criticalVendorsAtRisk} />
        <Row left="Audit readiness" right={compliance.auditReadiness.status} />
        <Row left="Published policies" right={compliance.policyStatus.published} />
      </div>
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

// ============================================================
// BOARD REPORTS
// ============================================================
function BoardReportsTab({ orgId, actorEmail }) {
  const [reports, setReports] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setError("");
      setReports((await api(`/api/orgs/board-reports?orgId=${orgId}`)).reports);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  async function draft() {
    try {
      setError("");
      await api("/api/orgs/board-reports", { method: "POST", body: JSON.stringify({ orgId }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function publish(reportId) {
    try {
      setError("");
      await api(`/api/orgs/board-reports/${reportId}/publish`, { method: "POST", body: JSON.stringify({ orgId }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="space-y-4">
      <button onClick={draft} className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg">Draft new report</button>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!reports ? <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p> : reports.length === 0 ? (
          <EmptyState compact icon="📋" description="No board reports drafted yet." />
        ) : (
          <div className="space-y-2">
            {reports.map((r) => (
              <div key={r.id} className="bg-black/20 border border-white/5 rounded-lg p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[var(--inaya-text-primary)] text-sm">{new Date(r.draftedAt).toLocaleString()}</span>
                  <div className="flex items-center gap-2">
                    <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full border ${r.status === "PUBLISHED" ? "border-emerald-400/30 text-emerald-400" : "border-amber-400/30 text-amber-400"}`}>{r.status}</span>
                    {r.status === "DRAFT" && <button onClick={() => publish(r.id)} className="text-[10px] font-bold uppercase text-[#00f2fe]">Publish</button>}
                  </div>
                </div>
                <p className="text-[11px] font-mono text-[var(--inaya-text-muted)] mt-1">
                  {r.sections.riskOverview.totalOpenRisks} open risk(s) · {r.sections.incidents.open} open incident(s) · {r.sections.compliance.compliancePosture.overallStatus} compliance
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
