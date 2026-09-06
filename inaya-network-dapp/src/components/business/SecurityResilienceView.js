"use client";

// src/components/business/SecurityResilienceView.js
//
// Financial Services & Regulated Enterprise SOW, Phase 5 (§61-72) —
// Security & Resilience. Cross-vertical (every org has vendors, ICT
// assets, and needs privileged-access/resilience controls, regardless of
// business type) -- unlike Health/Legal/Regulated/Financial OS, this view
// has no verticalOnly gate. Same self-contained-view pattern as every
// other View component in this app.

import { useState, useEffect, useCallback } from "react";
import EmptyState from "../EmptyState";

async function api(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

export default function SecurityResilienceView({ orgId, email }) {
  const [tab, setTab] = useState("dashboard");
  const TABS = ["dashboard", "vendors", "ict assets", "continuity", "disaster recovery", "resilience tests", "privileged access", "data residency", "sod rules"];
  return (
    <div className="space-y-5">
      <div className="flex bg-[var(--inaya-surface)] border border-white/5 rounded-xl p-1 w-fit flex-wrap">
        {TABS.map((t) => {
          const key = t.replace(/ /g, "");
          return <button key={t} onClick={() => setTab(key)} className={`px-3.5 py-2 text-[11px] font-bold uppercase rounded-lg ${tab === key ? "bg-[#00f2fe]/15 text-[#00f2fe]" : "text-[var(--inaya-text-muted)]"}`}>{t}</button>;
        })}
      </div>
      {tab === "dashboard" && <DashboardTab orgId={orgId} />}
      {tab === "vendors" && <VendorsTab orgId={orgId} actorEmail={email} />}
      {tab === "ictassets" && <IctAssetsTab orgId={orgId} />}
      {tab === "continuity" && <ContinuityTab orgId={orgId} />}
      {tab === "disasterrecovery" && <DisasterRecoveryTab orgId={orgId} />}
      {tab === "resiliencetests" && <ResilienceTestsTab orgId={orgId} />}
      {tab === "privilegedaccess" && <PrivilegedAccessTab orgId={orgId} actorEmail={email} />}
      {tab === "dataresidency" && <DataResidencyTab orgId={orgId} />}
      {tab === "sodrules" && <SodRulesTab orgId={orgId} />}
    </div>
  );
}

// ============================================================
// DASHBOARD (§70)
// ============================================================
function DashboardTab({ orgId }) {
  const [dashboard, setDashboard] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api(`/api/orgs/operational-resilience?orgId=${orgId}`).then(setDashboard).catch((err) => setError(err.message));
  }, [orgId]);

  if (error) return <p className="text-red-400 text-xs">{error}</p>;
  if (!dashboard) return <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p>;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat label="Critical functions" value={dashboard.criticalFunctionCount} />
        <Stat label="ICT assets" value={dashboard.ictAssetCount} />
        <Stat label="Critical assets" value={dashboard.criticalAssetCount} />
        <Stat label="Third parties" value={dashboard.thirdPartyCount} />
        <Stat label="Critical vendors" value={dashboard.criticalThirdPartyCount} />
        <Stat label="DR runbooks" value={dashboard.runbookCount} />
        <Stat label="Open incidents" value={dashboard.openIncidentCount} />
        <Stat label="Runbooks needing attention" value={dashboard.runbooksNeedingAttention.length} warn={dashboard.runbooksNeedingAttention.length > 0} />
      </div>
      {dashboard.uncoveredTestTypes.length > 0 && (
        <div className="bg-amber-400/10 border border-amber-400/30 rounded-xl p-4">
          <p className="text-[11px] font-bold uppercase text-amber-400 mb-1">Never-run test types</p>
          <p className="text-[12px] text-[var(--inaya-text-muted)] font-mono">{dashboard.uncoveredTestTypes.join(", ")}</p>
        </div>
      )}
      {dashboard.weaknesses.length > 0 && (
        <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
          <p className="text-[11px] font-bold uppercase text-[var(--inaya-text-muted)] mb-2">Weaknesses (failed or retest-required)</p>
          <div className="space-y-1.5">
            {dashboard.weaknesses.map((w, i) => <Row key={i} left={`${w.testType} · ${w.scope}`} right={w.result} />)}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, warn }) {
  return (
    <div className={`bg-black/20 border rounded-lg p-2.5 ${warn ? "border-amber-400/30" : "border-white/5"}`}>
      <p className="text-[10px] font-bold uppercase text-[var(--inaya-text-muted)]">{label}</p>
      <p className={`text-sm font-mono mt-0.5 ${warn ? "text-amber-400" : "text-[var(--inaya-text-primary)]"}`}>{value}</p>
    </div>
  );
}

// ============================================================
// VENDORS (§64-66)
// ============================================================
const VENDOR_NEXT_ACTION = {
  REQUESTED: "sendQuestionnaire", SECURITY_QUESTIONNAIRE: "submitEvidence", EVIDENCE: "submitForRiskAssessment",
  RISK_ASSESSMENT: "submitForLegalReview", LEGAL_REVIEW: "submitForProcurement", PROCUREMENT: "approve", APPROVED: "contract", CONTRACTED: "beginMonitoring",
};

function VendorsTab({ orgId, actorEmail }) {
  const [vendors, setVendors] = useState(null);
  const [expiring, setExpiring] = useState(null);
  const [name, setName] = useState("");
  const [service, setService] = useState("");
  const [criticality, setCriticality] = useState("medium");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setError("");
      const [v, e] = await Promise.all([api(`/api/orgs/vendor-records?orgId=${orgId}`), api(`/api/orgs/vendor-records/expiring?orgId=${orgId}`)]);
      setVendors(v.vendors);
      setExpiring(e.expiring);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  async function create(e) {
    e.preventDefault();
    if (!name.trim() || !service.trim()) return;
    try {
      setError("");
      await api("/api/orgs/vendor-records", { method: "POST", body: JSON.stringify({ orgId, name: name.trim(), service: service.trim(), criticality }) });
      setName(""); setService("");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function advance(vendorId, action) {
    try {
      setError("");
      await api(`/api/orgs/vendor-records/${vendorId}/onboarding`, { method: "PATCH", body: JSON.stringify({ orgId, action }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={create} className="flex flex-wrap gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Vendor name" className="flex-1 min-w-[140px] bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input value={service} onChange={(e) => setService(e.target.value)} placeholder="Service" className="flex-1 min-w-[120px] bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <select value={criticality} onChange={(e) => setCriticality(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
          {["low", "medium", "high", "critical"].map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <button disabled={!name.trim() || !service.trim()} className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg disabled:opacity-40">Add vendor</button>
      </form>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      {expiring && expiring.length > 0 && (
        <div className="bg-amber-400/10 border border-amber-400/30 rounded-xl p-3">
          <p className="text-[11px] font-bold uppercase text-amber-400 mb-1.5">Expiring within 30 days</p>
          {expiring.map((e, i) => <p key={i} className="text-[12px] text-[var(--inaya-text-muted)]">{e.vendorName} · {e.itemType} · {new Date(e.expiresAt).toLocaleDateString()}{e.alreadyExpired ? " (already expired)" : ""}</p>)}
        </div>
      )}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!vendors ? <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p> : vendors.length === 0 ? (
          <EmptyState compact icon="🏭" description="No vendors registered yet." />
        ) : (
          <div className="space-y-2">
            {vendors.map((v) => (
              <div key={v.id} className="flex items-center justify-between gap-3 bg-black/20 border border-white/5 rounded-lg p-3">
                <div className="min-w-0">
                  <span className="text-[var(--inaya-text-primary)] text-sm">{v.name}</span>
                  <p className="text-[var(--inaya-text-muted)] text-[12px] font-mono mt-0.5">{v.service} · {v.criticality} · review: {v.securityReviewStatus}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[11px] font-bold uppercase px-2 py-0.5 rounded-full border border-white/10 text-[var(--inaya-text-muted)]">{v.onboardingStatus.replace(/_/g, " ")}</span>
                  {VENDOR_NEXT_ACTION[v.onboardingStatus] && <button onClick={() => advance(v.id, VENDOR_NEXT_ACTION[v.onboardingStatus])} className="text-[10px] font-bold uppercase text-[#00f2fe]">Advance</button>}
                  {!["APPROVED", "CONTRACTED", "MONITORING", "REJECTED"].includes(v.onboardingStatus) && <button onClick={() => advance(v.id, "reject")} className="text-[10px] font-bold uppercase text-[var(--inaya-text-muted)] hover:text-red-400">Reject</button>}
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
// ICT ASSETS (§67)
// ============================================================
function IctAssetsTab({ orgId }) {
  const [assets, setAssets] = useState(null);
  const [name, setName] = useState("");
  const [type, setType] = useState("application");
  const [error, setError] = useState("");
  const TYPES = ["application", "server", "endpoint", "database", "saas", "api", "network", "cloud_resource", "data_store", "third_party_dependency"];

  const load = useCallback(async () => {
    try {
      setError("");
      setAssets((await api(`/api/orgs/ict-assets?orgId=${orgId}`)).assets);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  async function create(e) {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      setError("");
      await api("/api/orgs/ict-assets", { method: "POST", body: JSON.stringify({ orgId, name: name.trim(), type }) });
      setName("");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={create} className="flex flex-wrap gap-2">
        <select value={type} onChange={(e) => setType(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
          {TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}
        </select>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Asset name" className="flex-1 min-w-[160px] bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <button disabled={!name.trim()} className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg disabled:opacity-40">Register asset</button>
      </form>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!assets ? <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p> : assets.length === 0 ? (
          <EmptyState compact icon="🖥️" description="No ICT assets registered yet." />
        ) : (
          <div className="space-y-2">{assets.map((a) => <Row key={a.id} left={a.name} right={`${a.type.replace(/_/g, " ")} · ${a.criticality} · ${a.environment}`} />)}</div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// BUSINESS CONTINUITY (§68)
// ============================================================
function ContinuityTab({ orgId }) {
  const [functions, setFunctions] = useState(null);
  const [name, setName] = useState("");
  const [rto, setRto] = useState("");
  const [expanded, setExpanded] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setError("");
      setFunctions((await api(`/api/orgs/critical-functions?orgId=${orgId}`)).functions);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  async function create(e) {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      setError("");
      await api("/api/orgs/critical-functions", { method: "POST", body: JSON.stringify({ orgId, name: name.trim(), recoveryTimeObjectiveHours: rto ? parseFloat(rto) : undefined }) });
      setName(""); setRto("");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={create} className="flex flex-wrap gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Critical function name" className="flex-1 min-w-[160px] bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input value={rto} onChange={(e) => setRto(e.target.value)} type="number" placeholder="RTO (hours)" className="w-32 bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <button disabled={!name.trim()} className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg disabled:opacity-40">Add function</button>
      </form>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!functions ? <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p> : functions.length === 0 ? (
          <EmptyState compact icon="🔁" description="No critical business functions registered yet." />
        ) : (
          <div className="space-y-2">
            {functions.map((f) => (
              <div key={f.id} className="bg-black/20 border border-white/5 rounded-lg p-3">
                <button onClick={() => setExpanded(expanded === f.id ? null : f.id)} className="w-full flex items-center justify-between gap-3 text-left">
                  <span className="text-[var(--inaya-text-primary)] text-sm">{f.name}</span>
                  <span className="text-[11px] font-mono text-[var(--inaya-text-muted)] shrink-0">RTO {f.recoveryTimeObjectiveHours ?? "—"}h</span>
                </button>
                {expanded === f.id && <ContinuityPlanSection orgId={orgId} functionId={f.id} />}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ContinuityPlanSection({ orgId, functionId }) {
  const [plans, setPlans] = useState(null);
  const [planText, setPlanText] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setError("");
      setPlans((await api(`/api/orgs/critical-functions/${functionId}/continuity-plan?orgId=${orgId}`)).plans);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId, functionId]);

  useEffect(() => { load(); }, [load]);

  async function create(e) {
    e.preventDefault();
    if (!planText.trim()) return;
    try {
      setError("");
      await api(`/api/orgs/critical-functions/${functionId}/continuity-plan`, { method: "POST", body: JSON.stringify({ orgId, planText: planText.trim() }) });
      setPlanText("");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function recordTest(planId, result) {
    try {
      setError("");
      await api(`/api/orgs/continuity-plans/${planId}/test`, { method: "POST", body: JSON.stringify({ orgId, result }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="mt-2 pt-2 border-t border-white/5 space-y-2">
      <form onSubmit={create} className="flex gap-2">
        <input value={planText} onChange={(e) => setPlanText(e.target.value)} placeholder="Continuity plan text" className="flex-1 bg-black/45 border border-white/15 rounded-lg px-2 py-1 text-[10px] text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <button disabled={!planText.trim()} className="text-[10px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-2.5 py-1 rounded-lg disabled:opacity-40">Create plan</button>
      </form>
      {error && <p className="text-red-400 text-[10px]">{error}</p>}
      {!plans || plans.length === 0 ? <Empty /> : plans.map((p) => (
        <div key={p.id} className="bg-black/20 rounded-lg p-2">
          <p className="text-[11px] text-[var(--inaya-text-primary)]">{p.planText}</p>
          <p className="text-[10px] font-mono text-[var(--inaya-text-muted)] mt-1">{p.testLog.length} test(s) recorded</p>
          <div className="flex gap-1.5 mt-1">
            {["pass", "fail", "partial"].map((r) => <button key={r} onClick={() => recordTest(p.id, r)} className="text-[10px] font-bold uppercase text-[#00f2fe]">Log {r}</button>)}
          </div>
        </div>
      ))}
    </div>
  );
}

// ============================================================
// DISASTER RECOVERY (§69)
// ============================================================
function DisasterRecoveryTab({ orgId }) {
  const [runbooks, setRunbooks] = useState(null);
  const [name, setName] = useState("");
  const [procedure, setProcedure] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setError("");
      setRunbooks((await api(`/api/orgs/dr-runbooks?orgId=${orgId}`)).runbooks);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  async function create(e) {
    e.preventDefault();
    if (!name.trim() || !procedure.trim()) return;
    try {
      setError("");
      await api("/api/orgs/dr-runbooks", { method: "POST", body: JSON.stringify({ orgId, name: name.trim(), restorationProcedure: procedure.trim() }) });
      setName(""); setProcedure("");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function recordTest(runbookId, result) {
    try {
      setError("");
      await api(`/api/orgs/dr-runbooks/${runbookId}/test`, { method: "POST", body: JSON.stringify({ orgId, result }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={create} className="flex flex-wrap gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Runbook name" className="flex-1 min-w-[140px] bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input value={procedure} onChange={(e) => setProcedure(e.target.value)} placeholder="Restoration procedure" className="flex-1 min-w-[160px] bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <button disabled={!name.trim() || !procedure.trim()} className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg disabled:opacity-40">Create runbook</button>
      </form>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!runbooks ? <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p> : runbooks.length === 0 ? (
          <EmptyState compact icon="🛟" description="No DR runbooks yet." />
        ) : (
          <div className="space-y-2">
            {runbooks.map((r) => (
              <div key={r.id} className="bg-black/20 border border-white/5 rounded-lg p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[var(--inaya-text-primary)] text-sm">{r.name}</span>
                  {r.attentionReason ? <span className="text-[11px] font-bold uppercase px-2 py-0.5 rounded-full border border-amber-400/30 text-amber-400">{r.attentionReason.replace(/_/g, " ")}</span> : <span className="text-[11px] font-bold uppercase px-2 py-0.5 rounded-full border border-emerald-400/30 text-emerald-400">recovery ready</span>}
                </div>
                <div className="flex gap-1.5 mt-2">
                  {["pass", "fail", "partial"].map((res) => <button key={res} onClick={() => recordTest(r.id, res)} className="text-[10px] font-bold uppercase text-[#00f2fe]">Log {res}</button>)}
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
// RESILIENCE TESTS (§71)
// ============================================================
function ResilienceTestsTab({ orgId }) {
  const [data, setData] = useState(null);
  const [testType, setTestType] = useState("vulnerability");
  const [scope, setScope] = useState("");
  const [result, setResult] = useState("pass");
  const [error, setError] = useState("");
  const TYPES = ["vulnerability", "penetration", "tabletop", "failover", "backup_restore", "disaster_recovery", "incident_simulation", "dependency_failure", "scenario", "performance", "end_to_end"];

  const load = useCallback(async () => {
    try {
      setError("");
      setData(await api(`/api/orgs/resilience-tests?orgId=${orgId}`));
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  async function create(e) {
    e.preventDefault();
    if (!scope.trim()) return;
    try {
      setError("");
      await api("/api/orgs/resilience-tests", { method: "POST", body: JSON.stringify({ orgId, testType, scope: scope.trim(), result }) });
      setScope("");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={create} className="flex flex-wrap gap-2">
        <select value={testType} onChange={(e) => setTestType(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
          {TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}
        </select>
        <input value={scope} onChange={(e) => setScope(e.target.value)} placeholder="Scope" className="flex-1 min-w-[140px] bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <select value={result} onChange={(e) => setResult(e.target.value)} className="bg-black/45 border border-white/15 rounded-lg px-2.5 py-2 text-xs text-[var(--inaya-text-primary)]">
          {["pass", "fail", "partial"].map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <button disabled={!scope.trim()} className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg disabled:opacity-40">Record test</button>
      </form>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      {data && data.uncoveredTestTypes.length > 0 && <p className="text-[11px] font-mono text-amber-400">Never run: {data.uncoveredTestTypes.join(", ")}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!data ? <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p> : data.tests.length === 0 ? (
          <EmptyState compact icon="🧪" description="No resilience tests recorded yet." />
        ) : (
          <div className="space-y-2">{data.tests.map((t) => <Row key={t.id} left={`${t.testType.replace(/_/g, " ")} · ${t.scope}`} right={t.result} />)}</div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// PRIVILEGED ACCESS (§62-63)
// ============================================================
function PrivilegedAccessTab({ orgId, actorEmail }) {
  const [sessions, setSessions] = useState(null);
  const [scope, setScope] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setError("");
      setSessions((await api(`/api/orgs/privileged-sessions?orgId=${orgId}`)).sessions);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  async function request(e) {
    e.preventDefault();
    if (!scope.trim() || !reason.trim()) return;
    try {
      setError("");
      await api("/api/orgs/privileged-sessions", { method: "POST", body: JSON.stringify({ orgId, action: "request", scope: scope.trim(), reason: reason.trim(), requestedHours: 4 }) });
      setScope(""); setReason("");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function breakGlass() {
    if (!scope.trim() || !reason.trim()) { setError("Scope and reason are required for break-glass access too."); return; }
    try {
      setError("");
      await api("/api/orgs/privileged-sessions", { method: "POST", body: JSON.stringify({ orgId, action: "breakGlass", scope: scope.trim(), reason: reason.trim(), hours: 4 }) });
      setScope(""); setReason("");
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function act(sessionId, action, extra) {
    try {
      setError("");
      await api(`/api/orgs/privileged-sessions/${sessionId}`, { method: "PATCH", body: JSON.stringify({ orgId, action, ...extra }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  function review(sessionId) {
    act(sessionId, "review", { attestation: `Reviewed by ${actorEmail} — access confirmed appropriate.` });
  }

  return (
    <div className="space-y-4">
      <form className="flex flex-wrap gap-2">
        <input value={scope} onChange={(e) => setScope(e.target.value)} placeholder="Scope (e.g. prod-db-01)" className="flex-1 min-w-[140px] bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason" className="flex-1 min-w-[140px] bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <button onClick={request} disabled={!scope.trim() || !reason.trim()} className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg disabled:opacity-40">Request elevation</button>
        <button onClick={breakGlass} disabled={!scope.trim() || !reason.trim()} className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-red-400 to-amber-400 px-3.5 py-2 rounded-lg disabled:opacity-40">🚨 Break-glass</button>
      </form>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!sessions ? <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p> : sessions.length === 0 ? (
          <EmptyState compact icon="🔑" description="No privileged access sessions yet." />
        ) : (
          <div className="space-y-2">
            {sessions.map((s) => (
              <div key={s.id} className="flex items-center justify-between gap-3 bg-black/20 border border-white/5 rounded-lg p-3">
                <div className="min-w-0">
                  <span className="text-[var(--inaya-text-primary)] text-sm">{s.grantType === "break_glass" ? "🚨 " : ""}{s.scope}</span>
                  <p className="text-[var(--inaya-text-muted)] text-[12px] font-mono mt-0.5">{s.reason}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[11px] font-bold uppercase px-2 py-0.5 rounded-full border border-white/10 text-[var(--inaya-text-muted)]">{s.status}</span>
                  {s.status === "PENDING_APPROVAL" && <button onClick={() => act(s.id, "approve")} className="text-[10px] font-bold uppercase text-emerald-400">Approve</button>}
                  {s.status === "PENDING_APPROVAL" && <button onClick={() => act(s.id, "reject")} className="text-[10px] font-bold uppercase text-red-400">Reject</button>}
                  {s.status === "ACTIVE" && <button onClick={() => act(s.id, "revoke")} className="text-[10px] font-bold uppercase text-red-400">Revoke</button>}
                  {!s.reviewedAt && s.status !== "PENDING_APPROVAL" && <button onClick={() => review(s.id)} className="text-[10px] font-bold uppercase text-[#00f2fe]">Review</button>}
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
// DATA RESIDENCY (§72)
// ============================================================
function DataResidencyTab({ orgId }) {
  const [policy, setPolicy] = useState(null);
  const [country, setCountry] = useState("");
  const [region, setRegion] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setError("");
      const d = await api(`/api/orgs/data-residency-policy?orgId=${orgId}`);
      setPolicy(d.policy);
      setCountry(d.policy?.country || ""); setRegion(d.policy?.region || "");
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  async function save(e) {
    e.preventDefault();
    try {
      setError("");
      await api("/api/orgs/data-residency-policy", { method: "POST", body: JSON.stringify({ orgId, country: country.trim() || null, region: region.trim() || null }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={save} className="flex flex-wrap gap-2">
        <input value={country} onChange={(e) => setCountry(e.target.value)} placeholder="Country" className="flex-1 min-w-[120px] bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="Region" className="flex-1 min-w-[120px] bg-black/45 border border-white/15 rounded-lg px-3 py-2 text-xs text-[var(--inaya-text-primary)] placeholder-[#8a96ab]" />
        <button className="text-[12px] font-bold uppercase text-black bg-gradient-to-r from-[#00f2fe] to-[#4facfe] px-3.5 py-2 rounded-lg">Save policy</button>
      </form>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      {policy && <p className="text-[11px] font-mono text-[var(--inaya-text-muted)]">Last updated {new Date(policy.updatedAt).toLocaleString()}</p>}
    </div>
  );
}

// ============================================================
// SEGREGATION OF DUTIES (§61)
// ============================================================
function SodRulesTab({ orgId }) {
  const [rules, setRules] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setError("");
      setRules((await api(`/api/orgs/sod-rules?orgId=${orgId}`)).rules);
    } catch (err) {
      setError(err.message);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  async function toggle(ruleType, enabled) {
    try {
      setError("");
      await api("/api/orgs/sod-rules", { method: "PATCH", body: JSON.stringify({ orgId, ruleType, enabled: !enabled }) });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="space-y-4">
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="bg-[var(--inaya-surface)] border border-white/5 rounded-2xl p-5">
        {!rules ? <p className="text-[var(--inaya-text-muted)] font-mono text-sm">Loading…</p> : (
          <div className="space-y-2">
            {rules.map((r) => (
              <div key={r.ruleType} className="flex items-center justify-between gap-3 bg-black/20 border border-white/5 rounded-lg p-3">
                <span className="text-[var(--inaya-text-primary)] text-sm">{r.ruleType.replace(/_/g, " ")}</span>
                <button onClick={() => toggle(r.ruleType, r.enabled)} className={`text-[11px] font-bold uppercase px-2.5 py-1 rounded-full border ${r.enabled ? "border-emerald-400/30 text-emerald-400" : "border-white/10 text-[var(--inaya-text-muted)]"}`}>{r.enabled ? "enabled" : "disabled"}</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// SHARED PRIMITIVES
// ============================================================
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
